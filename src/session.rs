//! `POST /session`: the page opens a board. The plugin locks the file for
//! the user (one editor at a time), gives the board a token for it and tells
//! the page where the board is.

use serde_json::json;

use crate::backend::{Backend, FileError, LockError, Request, TokenError, User};
use crate::{web, APP_ID};

/// How long the board may work with the file it was given: a working day.
/// The server allows 12 hours at most; later the board asks the page for a
/// new token.
pub const TOKEN_SECONDS: u32 = 10 * 3600;
/// The lock of an open board; the board renews it every 10 minutes.
pub const LOCK_SECONDS: u32 = 30 * 60;
/// Where the board is: the path of `[[proxy]]` on the server's address.
pub const SERVICE_PATH: &str = "/whiteboard/";

/// The mime type of boards (Nextcloud's for both extensions).
pub const MIME: &str = "application/vnd.excalidraw+json";

/// Whether the file is a board: `.excalidraw` (Excalidraw's own),
/// `.whiteboard` (Nextcloud Whiteboard) or of the boards' mime type.
pub fn is_board(name: &str, mime_type: Option<&str>) -> bool {
    let extension = name.rsplit_once('.').map(|(_, ext)| ext.to_ascii_lowercase());
    matches!(extension.as_deref(), Some("excalidraw" | "whiteboard")) || mime_type == Some(MIME)
}

/// The plugin's server settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Settings {
    /// The whiteboard service as the server reaches it (`http://whiteboard:8080`);
    /// browsers reach it through the server's address (`[[proxy]]`).
    pub service_url: Option<String>,
}

impl Settings {
    pub fn of(backend: &dyn Backend) -> Self {
        Settings { service_url: web::base_url(backend.settings()["service_url"].as_str()) }
    }
}

/// Why a board opens read-only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReadOnly {
    /// The page asked for it.
    Requested,
    /// The user may not change the file (shared read-only).
    NoPermission,
    /// Another app edits it.
    LockedByApp,
    /// Someone else has it open in the whiteboard.
    LockedByUser,
}

impl ReadOnly {
    fn code(self) -> &'static str {
        match self {
            ReadOnly::Requested => "requested",
            ReadOnly::NoPermission => "no-permission",
            ReadOnly::LockedByApp => "locked-by-app",
            ReadOnly::LockedByUser => "locked-by-user",
        }
    }
}

/// `POST /session?file=<id>[&write=0]`: a token for the file, the lock if the
/// user edits it, and why not if not.
///
/// ```json
/// { "token": "…", "expires_at": "…", "write": true, "lock": "wb-…", "lock_expires_at": "…",
///   "read_only": null, "locked_by": null, "name": "Plan.excalidraw", "service": "/whiteboard/" }
/// ```
pub fn open(backend: &dyn Backend, user: &User, request: &Request) -> crate::backend::Reply {
    let id = web::query_param(&request.query, "file");
    if !web::valid_id(&id) {
        return web::error(400, "bad-request", "No file");
    }
    if Settings::of(backend).service_url.is_none() {
        return web::error(
            503,
            "no-service-url",
            "The administrator has not set the address of the whiteboard service",
        );
    }
    let file = match backend.file(&id) {
        Ok(file) => file,
        Err(FileError::NotFound) => return web::error(404, "not-found", "The file is not open for the app"),
        Err(err) => return web::error(500, "failed", &format!("{err:?}")),
    };
    if !is_board(&file.name, file.mime_type.as_deref()) {
        return web::error(415, "unsupported", "Not a whiteboard file (.excalidraw, .whiteboard)");
    }

    let mut read_only = (web::query_param(&request.query, "write") == "0").then_some(ReadOnly::Requested);
    let mut locked_by = None;
    let mut lock = None;
    if read_only.is_none() {
        match take_lock(backend, user, &id) {
            Ok((lock_id, expires_at)) => lock = Some((lock_id, expires_at)),
            Err(Refused::ReadOnly(why, app)) => {
                read_only = Some(why);
                locked_by = app;
            }
            Err(Refused::NotFound) => return web::error(404, "not-found", "The file is not open for the app"),
            Err(Refused::Failed(why)) => return web::error(500, "failed", &format!("lock: {why}")),
        }
    }

    let write = lock.is_some();
    let token = match backend.issue_token(&id, write, TOKEN_SECONDS) {
        Ok(token) => token,
        Err(TokenError::ReadOnly) if write => {
            // The user lost the right to change it between the lock and now.
            if let Some((lock_id, _)) = &lock {
                let _ = backend.unlock(&id, lock_id);
            }
            return web::error(409, "retry", "The file's permissions changed: open it again");
        }
        Err(TokenError::NotFound) => return web::error(404, "not-found", "The file is not open for the app"),
        Err(err) => return web::error(500, "failed", &format!("token: {err:?}")),
    };
    let (lock_id, lock_expires_at) = lock.unzip();
    web::json(
        200,
        json!({
            "token": token.token,
            "expires_at": token.expires_at,
            "write": write,
            "lock": lock_id,
            "lock_expires_at": lock_expires_at,
            "read_only": read_only.map(ReadOnly::code),
            "locked_by": locked_by,
            "name": file.name,
            "service": SERVICE_PATH,
        }),
    )
}

enum Refused {
    /// Opens read-only: why, and the app that holds the lock.
    ReadOnly(ReadOnly, Option<String>),
    NotFound,
    Failed(String),
}

/// Takes the lock for the user: their own lock of the whiteboard (another tab,
/// a reload, a new token) is taken over with a new lock id, anyone else's makes
/// the board read-only.
fn take_lock(backend: &dyn Backend, user: &User, id: &str) -> Result<(String, String), Refused> {
    let held = match backend.get_lock(id) {
        Ok(held) => held,
        Err(FileError::NotFound) => return Err(Refused::NotFound),
        Err(err) => return Err(Refused::Failed(format!("{err:?}"))),
    };
    let lock_id = match &held {
        Some(held) if held.app_id != APP_ID => {
            return Err(Refused::ReadOnly(ReadOnly::LockedByApp, Some(held.app_id.clone())))
        }
        Some(held) if held.user_id != user.id => {
            return Err(Refused::ReadOnly(ReadOnly::LockedByUser, Some(held.app_id.clone())))
        }
        // The user's own: this opening takes it over with a lock of its own,
        // so the other tab's next save finds out (`409 locked`, by "self").
        Some(held) => {
            match backend.unlock(id, &held.lock_id) {
                Ok(()) | Err(LockError::Locked(_)) => {}
                Err(LockError::NotFound) => return Err(Refused::NotFound),
                Err(LockError::ReadOnly) => return Err(Refused::ReadOnly(ReadOnly::NoPermission, None)),
                Err(LockError::Other(why)) => return Err(Refused::Failed(why)),
            }
            new_lock_id(backend, user)
        }
        None => new_lock_id(backend, user),
    };
    match backend.lock(id, &lock_id, LOCK_SECONDS) {
        Ok(expires_at) => Ok((lock_id, expires_at)),
        Err(LockError::ReadOnly) => Err(Refused::ReadOnly(ReadOnly::NoPermission, None)),
        // Someone was quicker.
        Err(LockError::Locked(held)) if held.app_id != APP_ID => {
            Err(Refused::ReadOnly(ReadOnly::LockedByApp, Some(held.app_id)))
        }
        Err(LockError::Locked(held)) => Err(Refused::ReadOnly(ReadOnly::LockedByUser, Some(held.app_id))),
        Err(LockError::NotFound) => Err(Refused::NotFound),
        Err(LockError::Other(why)) => Err(Refused::Failed(why)),
    }
}

/// A lock id of its own for each opening: `wb-<ms>-<user>`. It is no secret:
/// saving needs the token too.
fn new_lock_id(backend: &dyn Backend, user: &User) -> String {
    let who: String = user.id.chars().filter(char::is_ascii_alphanumeric).take(12).collect();
    format!("wb-{}-{who}", backend.now_ms())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::fake::{Fake, FILE, USER};

    fn user() -> User {
        User { id: USER.into(), username: "alice".into(), display_name: "Alice".into() }
    }

    fn open_with(fake: &Fake, query: &str) -> (u16, serde_json::Value) {
        let request =
            Request { method: "POST".into(), path: "/session".into(), query: query.into(), ..Request::default() };
        let reply = open(fake, &user(), &request);
        (reply.status, serde_json::from_slice(&reply.body).unwrap())
    }

    fn query() -> String {
        format!("file={FILE}")
    }

    #[test]
    fn opens_a_board_for_editing() {
        let fake = Fake::user();
        let (status, body) = open_with(&fake, &query());
        assert_eq!(status, 200, "{body}");
        assert_eq!(body["write"], true);
        assert_eq!(body["token"], format!("token-{FILE}-true-36000"));
        assert_eq!(body["lock"], "wb-1794300000000-7f0000000000");
        assert_eq!(fake.lock_id().as_deref(), Some("wb-1794300000000-7f0000000000"));
        assert_eq!(body["read_only"], serde_json::Value::Null);
        assert_eq!(body["service"], "/whiteboard/");
        assert_eq!(body["name"], "Plan.excalidraw");
    }

    #[test]
    fn takes_over_its_own_lock() {
        let fake = Fake::user();
        fake.lock_as(APP_ID, USER, "wb-1-old");
        let (_, body) = open_with(&fake, &query());
        // A lock of its own: the other tab's next save is refused.
        assert_eq!(
            (body["write"].clone(), body["lock"].clone()),
            (json!(true), json!("wb-1794300000000-7f0000000000"))
        );
        assert_eq!(fake.lock_id().as_deref(), Some("wb-1794300000000-7f0000000000"));
    }

    #[test]
    fn read_only_when_someone_else_edits() {
        let fake = Fake::user();
        fake.lock_as(APP_ID, "someone-else", "wb-1-bob");
        let (status, body) = open_with(&fake, &query());
        assert_eq!(status, 200);
        assert_eq!(body["write"], false);
        assert_eq!(body["read_only"], "locked-by-user");
        assert_eq!(body["token"], format!("token-{FILE}-false-36000"));
        assert_eq!(fake.lock_id().as_deref(), Some("wb-1-bob"), "the lock stays theirs");

        let office = Fake::user();
        office.lock_as("rc-office", USER, "L1");
        let (_, body) = open_with(&office, &query());
        assert_eq!(
            (body["read_only"].clone(), body["locked_by"].clone()),
            (json!("locked-by-app"), json!("rc-office"))
        );
    }

    #[test]
    fn read_only_without_permission_or_when_asked() {
        let shared = Fake { writable: false, ..Fake::user() };
        let (_, body) = open_with(&shared, &query());
        assert_eq!((body["write"].clone(), body["read_only"].clone()), (json!(false), json!("no-permission")));
        assert_eq!(body["lock"], serde_json::Value::Null);

        let fake = Fake::user();
        let (_, body) = open_with(&fake, &format!("{}&write=0", query()));
        assert_eq!(body["read_only"], "requested");
        assert_eq!(fake.lock_id(), None, "no lock to view");
    }

    #[test]
    fn boards_only() {
        assert!(is_board("Plan.excalidraw", None));
        assert!(is_board("Old.WHITEBOARD", Some("application/octet-stream")));
        assert!(is_board("board", Some(MIME)));
        assert!(!is_board("excalidraw", None));
        assert!(!is_board("notes.json", Some("application/json")));
        let fake = Fake::user();
        fake.set_name("photo.jpg");
        assert_eq!(open_with(&fake, &query()).1["error"], "unsupported");
    }

    #[test]
    fn explains_failures() {
        let unset = Fake { settings: json!({}), ..Fake::user() };
        assert_eq!(open_with(&unset, &query()), (503, open_with(&unset, &query()).1));
        assert_eq!(open_with(&unset, &query()).1["error"], "no-service-url");
        let fake = Fake::user();
        assert_eq!(open_with(&fake, "file=0000").0, 404);
        assert_eq!(open_with(&fake, "file=../x").0, 400);
        assert_eq!(open_with(&fake, "").0, 400);
    }
}
