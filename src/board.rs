//! The board's routes, called by the board (the service's page on the
//! server's address) with the token of its file:
//!
//! | Route                                    | What                                       |
//! |------------------------------------------|--------------------------------------------|
//! | `GET /board/<id>`                        | the file, sent by the server (`ETag`)       |
//! | `GET /board/<id>/info`                   | `{ name, size, etag, updated_at }`          |
//! | `PUT /board/<id>?lock=<lock>`, `If-Match` | saves the body, of any size; the new etag  |
//! | `POST /lock/<id>?lock=<lock>&action=refresh\|unlock` | renews or ends the lock        |
//!
//! Neither read nor write passes the board through the plugin's memory: the
//! server sends the file itself (`x-rustcloud-send`) and saves the request
//! body into it (`write-request-body`).

use serde_json::json;

use crate::backend::{Backend, FileError, Lock, LockError, Reply, Request, Scope, User};
use crate::session::LOCK_SECONDS;
use crate::{web, APP_ID};

/// The header the server sets on a large body it keeps on disk.
const BODY_SIZE: &str = "x-rustcloud-body-size";

/// `/board/…` and `/lock/…`; `rest` is the path after `/board/` or `/lock/`.
pub fn handle(backend: &dyn Backend, user: &User, request: &Request, lock_route: bool, rest: &str) -> Reply {
    let Some(scope) = backend.token() else {
        return web::error(401, "no-token", "The board's routes take the token of its file");
    };
    let (id, info) = match rest.strip_suffix("/info") {
        Some(id) => (id, true),
        None => (rest, false),
    };
    if !web::valid_id(id) || id != scope.file {
        return web::error(404, "not-found", "Not the file of this token");
    }
    match (request.method.as_str(), lock_route, info) {
        ("GET", false, false) => read(backend, id),
        ("GET", false, true) => describe(backend, id),
        ("PUT", false, false) => save(backend, user, &scope, request, id),
        ("POST", true, false) => lock(backend, user, &scope, request, id),
        _ => web::error(405, "method-not-allowed", "Not here"),
    }
}

fn read(backend: &dyn Backend, id: &str) -> Reply {
    match backend.file(id) {
        // The server answers with the file and its ETag, which saving takes as If-Match.
        Ok(_) => web::empty(200)
            .with_header("x-rustcloud-send", format!("file:{id}"))
            .with_header("cache-control", "no-store"),
        Err(err) => file_error(backend, "read", err),
    }
}

fn describe(backend: &dyn Backend, id: &str) -> Reply {
    match backend.file(id) {
        Ok(file) => web::json(
            200,
            json!({ "name": file.name, "size": file.size, "etag": file.etag, "updated_at": file.updated_at }),
        ),
        Err(err) => file_error(backend, "info", err),
    }
}

fn save(backend: &dyn Backend, user: &User, scope: &Scope, request: &Request, id: &str) -> Reply {
    if !scope.write {
        return web::error(403, "read-only", "The board is open read-only");
    }
    let Some(etag) = web::if_match(request.header("if-match")) else {
        return web::error(428, "no-if-match", "Saving needs If-Match: the ETag the board was read with");
    };
    // An empty body would wipe the board: a board always has some JSON.
    if request.body.is_empty() && request.header(BODY_SIZE).is_none() {
        return web::error(400, "empty", "Nothing to save");
    }
    let lock_id = web::query_param(&request.query, "lock");
    if let Err(reply) = hold_lock(backend, user, id, &lock_id) {
        return reply;
    }
    match backend.write_body(id, Some(&etag)) {
        Ok(saved) => web::json(200, json!({ "etag": saved.etag, "updated_at": saved.updated_at, "size": saved.size })),
        Err(FileError::Conflict) => match backend.get_lock(id) {
            Ok(Some(held)) if held.app_id != APP_ID || held.lock_id != lock_id => locked(user, &held),
            _ => web::error(409, "changed", "The file changed since the board read it"),
        },
        Err(FileError::NoSpace) => web::error(507, "no-space", "Not enough space (quota or disk)"),
        Err(FileError::TooLarge) => web::error(413, "too-large", "The board is larger than the server takes"),
        Err(err) => file_error(backend, "save", err),
    }
}

/// Saving only under the board's own lock. One that ran out (a laptop that
/// slept) is taken again if nobody else took the file meanwhile; If-Match
/// still tells whether it changed.
fn hold_lock(backend: &dyn Backend, user: &User, id: &str, lock_id: &str) -> Result<(), Reply> {
    if lock_id.is_empty() {
        return Err(web::error(400, "no-lock", "Saving needs the board's lock"));
    }
    match backend.get_lock(id) {
        Ok(Some(held)) if held.app_id == APP_ID && held.lock_id == lock_id => Ok(()),
        Ok(Some(held)) => Err(locked(user, &held)),
        Ok(None) => match backend.lock(id, lock_id, LOCK_SECONDS) {
            Ok(_) => Ok(()),
            Err(err) => Err(lock_error(backend, user, err)),
        },
        Err(err) => Err(file_error(backend, "lock", err)),
    }
}

fn lock(backend: &dyn Backend, user: &User, scope: &Scope, request: &Request, id: &str) -> Reply {
    if !scope.write {
        return web::error(403, "read-only", "The board is open read-only");
    }
    let lock_id = web::query_param(&request.query, "lock");
    if lock_id.is_empty() {
        return web::error(400, "no-lock", "No lock");
    }
    match web::query_param(&request.query, "action").as_str() {
        "refresh" => match backend.lock(id, &lock_id, LOCK_SECONDS) {
            Ok(expires_at) => web::json(200, json!({ "lock": lock_id, "expires_at": expires_at })),
            Err(err) => lock_error(backend, user, err),
        },
        "unlock" => match backend.unlock(id, &lock_id) {
            Ok(()) => web::empty(204),
            Err(err) => lock_error(backend, user, err),
        },
        _ => web::error(400, "bad-request", "action: refresh or unlock"),
    }
}

/// `409` with who holds the file now.
fn locked(user: &User, held: &Lock) -> Reply {
    let by = if held.app_id != APP_ID {
        "app"
    } else if held.user_id == user.id {
        // The same user's other tab took it over.
        "self"
    } else {
        "user"
    };
    web::json(
        409,
        json!({
            "error": "locked",
            "message": "Someone else edits the file now",
            "locked_by": held.app_id,
            "by": by,
        }),
    )
}

fn lock_error(backend: &dyn Backend, user: &User, err: LockError) -> Reply {
    match err {
        LockError::Locked(held) => locked(user, &held),
        LockError::ReadOnly => web::error(403, "read-only", "The user may not change the file"),
        LockError::NotFound => web::error(404, "not-found", "The file is not open for the app"),
        LockError::Other(why) => {
            backend.warn(&format!("lock: {why}"));
            web::error(500, "failed", &why)
        }
    }
}

fn file_error(backend: &dyn Backend, what: &str, err: FileError) -> Reply {
    match err {
        FileError::NotFound => web::error(404, "not-found", "The file is not open for the app"),
        FileError::ReadOnly => web::error(403, "read-only", "The user may not change the file"),
        err => {
            backend.warn(&format!("{what}: {err:?}"));
            web::error(500, "failed", &format!("{err:?}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::fake::{Fake, FILE, USER};

    fn user() -> User {
        User { id: USER.into(), username: "alice".into(), display_name: "Alice".into() }
    }

    fn call(fake: &Fake, method: &str, path: &str, query: &str, headers: &[(&str, &str)]) -> Reply {
        let request = Request {
            method: method.into(),
            path: path.into(),
            query: query.into(),
            headers: headers.iter().map(|(name, value)| (name.to_ascii_lowercase(), (*value).to_owned())).collect(),
            body: fake.body.clone(),
        };
        crate::route(fake, Some(&user()), &request)
    }

    fn put(fake: &Fake, lock: &str, if_match: &str) -> Reply {
        call(fake, "PUT", &format!("/board/{FILE}"), &format!("lock={lock}"), &[("If-Match", if_match)])
    }

    fn json_of(reply: &Reply) -> serde_json::Value {
        serde_json::from_slice(&reply.body).unwrap()
    }

    #[test]
    fn sends_the_file() {
        let fake = Fake::default();
        let reply = call(&fake, "GET", &format!("/board/{FILE}"), "", &[]);
        assert_eq!(reply.status, 200);
        assert_eq!(reply.header("x-rustcloud-send"), Some(format!("file:{FILE}").as_str()));
        assert!(reply.body.is_empty());
        let info = json_of(&call(&fake, "GET", &format!("/board/{FILE}/info"), "", &[]));
        assert_eq!((info["etag"].clone(), info["name"].clone()), (json!("etag-1"), json!("Plan.excalidraw")));
    }

    #[test]
    fn only_the_tokens_file() {
        let fake = Fake::default();
        assert_eq!(call(&fake, "GET", "/board/1111", "", &[]).status, 404);
        assert_eq!(call(&Fake::user(), "GET", &format!("/board/{FILE}"), "", &[]).status, 401);
    }

    #[test]
    fn saves_under_its_lock() {
        let fake = Fake::default();
        fake.lock_as(APP_ID, USER, "wb-1");
        let reply = put(&fake, "wb-1", "\"etag-1\"");
        assert_eq!(reply.status, 200, "{}", String::from_utf8_lossy(&reply.body));
        assert_eq!(json_of(&reply)["etag"], "etag-2");
        assert_eq!(fake.contents.borrow()[FILE], fake.body);
    }

    #[test]
    fn refuses_a_changed_file() {
        let fake = Fake::default();
        fake.lock_as(APP_ID, USER, "wb-1");
        let reply = put(&fake, "wb-1", "\"etag-0\"");
        assert_eq!((reply.status, json_of(&reply)["error"].clone()), (409, json!("changed")));
        assert_eq!(*fake.writes.borrow(), 0);
        assert_eq!(put(&fake, "wb-1", "*").status, 428);
        assert_eq!(call(&fake, "PUT", &format!("/board/{FILE}"), "lock=wb-1", &[]).status, 428);
    }

    #[test]
    fn refuses_without_its_lock() {
        let fake = Fake::default();
        fake.lock_as(APP_ID, "bob", "wb-2");
        let reply = put(&fake, "wb-1", "etag-1");
        assert_eq!(reply.status, 409);
        assert_eq!((json_of(&reply)["error"].clone(), json_of(&reply)["by"].clone()), (json!("locked"), json!("user")));

        let fake = Fake::default();
        fake.lock_as("rc-office", USER, "L1");
        assert_eq!(json_of(&put(&fake, "wb-1", "etag-1"))["by"], "app");

        let fake = Fake::default();
        fake.lock_as(APP_ID, USER, "wb-other-tab");
        assert_eq!(json_of(&put(&fake, "wb-1", "etag-1"))["by"], "self");

        assert_eq!(put(&Fake::default(), "", "etag-1").status, 400);
    }

    #[test]
    fn takes_a_lock_that_ran_out_again() {
        let fake = Fake::default();
        assert_eq!(put(&fake, "wb-1", "etag-1").status, 200);
        assert_eq!(fake.lock_id().as_deref(), Some("wb-1"));
    }

    #[test]
    fn read_only_token_does_not_save() {
        let fake = Fake { token: Some(Scope { file: FILE.into(), write: false }), ..Fake::default() };
        assert_eq!(put(&fake, "wb-1", "etag-1").status, 403);
        let lock = call(&fake, "POST", &format!("/lock/{FILE}"), "lock=wb-1&action=refresh", &[]);
        assert_eq!(lock.status, 403);
    }

    #[test]
    fn empty_body_is_no_board() {
        let fake = Fake { body: Vec::new(), ..Fake::default() };
        fake.lock_as(APP_ID, USER, "wb-1");
        assert_eq!(put(&fake, "wb-1", "etag-1").status, 400);
        // A large body the server keeps on disk comes without bytes.
        let reply =
            call(&fake, "PUT", &format!("/board/{FILE}"), "lock=wb-1", &[("If-Match", "etag-1"), (BODY_SIZE, "99")]);
        assert_eq!(reply.status, 200);
    }

    #[test]
    fn saving_errors() {
        let full = Fake { write_error: Some(FileError::NoSpace), ..Fake::default() };
        full.lock_as(APP_ID, USER, "wb-1");
        assert_eq!(put(&full, "wb-1", "etag-1").status, 507);
        let large = Fake { write_error: Some(FileError::TooLarge), ..Fake::default() };
        large.lock_as(APP_ID, USER, "wb-1");
        assert_eq!(put(&large, "wb-1", "etag-1").status, 413);
    }

    #[test]
    fn renews_and_ends_the_lock() {
        let fake = Fake::default();
        fake.lock_as(APP_ID, USER, "wb-1");
        let path = format!("/lock/{FILE}");
        let reply = call(&fake, "POST", &path, "lock=wb-1&action=refresh", &[]);
        assert_eq!((reply.status, json_of(&reply)["expires_at"].clone()), (200, json!("2026-11-10T10:30:00Z")));
        assert_eq!(call(&fake, "POST", &path, "lock=wb-9&action=refresh", &[]).status, 409);
        assert_eq!(call(&fake, "POST", &path, "lock=wb-1&action=jump", &[]).status, 400);
        assert_eq!(call(&fake, "POST", &path, "lock=wb-1&action=unlock", &[]).status, 204);
        assert_eq!(fake.lock_id(), None);
        assert_eq!(call(&fake, "GET", &path, "", &[]).status, 405);
    }
}
