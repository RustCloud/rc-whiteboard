//! Whiteboard: Excalidraw boards of the user's files, for RustCloud.
//!
//! The board itself runs in the browser: the whiteboard service (a container
//! of its own, `service/`) serves it on the server's address through
//! `[[proxy]]`. The plugin is what the board needs of the server: the page
//! that opens it (`ui/`, [`session`]: lock and token), the file's routes for
//! the token ([`board`]) and the administrator's report ([`status`]).
//! Versions, quota, the activity log and the trash stay the server's.
//!
//! The logic runs on [`backend::Backend`], so `cargo test` checks it on the
//! host without WebAssembly.

wit_bindgen::generate!({ path: "wit", world: "app" });

pub mod backend;
pub mod board;
mod host;
pub mod session;
pub mod status;
pub mod web;

use backend::{Backend, Reply};

pub const APP_ID: &str = "rc-whiteboard";

/// Answers a request to `/app/rc-whiteboard/…`.
pub fn route(backend: &dyn Backend, user: Option<&backend::User>, request: &backend::Request) -> Reply {
    let path = request.path.as_str();
    let board = path.strip_prefix("/board/").map(|rest| (false, rest));
    if let Some((lock_route, rest)) = board.or_else(|| path.strip_prefix("/lock/").map(|rest| (true, rest))) {
        return match user {
            Some(user) => board::handle(backend, user, request, lock_route, rest),
            None => web::error(401, "no-token", "The board's routes take the token of its file"),
        };
    }
    let html = "text/html; charset=utf-8";
    let js = "text/javascript; charset=utf-8";
    match (request.method.as_str(), path) {
        ("GET", "/edit") => web::asset(html, include_bytes!("../ui/edit.html")),
        ("GET", "/app.css") => web::asset("text/css; charset=utf-8", include_bytes!("../ui/app.css")),
        ("GET", "/i18n.js") => web::asset(js, include_bytes!("../ui/i18n.js")),
        ("GET", "/edit.js") => web::asset(js, include_bytes!("../ui/edit.js")),
        // The files panel's "New" menu.
        ("GET", "/templates/empty.excalidraw") => {
            web::asset(session::MIME, include_bytes!("../templates/empty.excalidraw"))
        }
        // The page's routes: the user's, never a token's.
        ("POST", "/session") | ("GET", "/status") if backend.token().is_some() => {
            web::error(403, "token", "Not with a token")
        }
        ("POST", "/session") | ("GET", "/status") if user.is_none() => web::error(401, "unauthorized", "Not logged in"),
        ("POST", "/session") => session::open(backend, user.expect("checked above"), request),
        ("GET", "/status") => status::status(backend),
        _ => web::error(404, "not-found", "Not found"),
    }
}

struct Whiteboard;

impl Guest for Whiteboard {
    fn handle(user: Option<User>, request: Request) -> Response {
        let request = backend::Request {
            method: request.method,
            path: request.path,
            query: request.query,
            headers: request.headers.into_iter().map(|(name, value)| (name.to_ascii_lowercase(), value)).collect(),
            body: request.body,
        };
        let user = user.map(backend::User::from);
        let reply = route(&host::Host, user.as_ref(), &request);
        Response { status: reply.status, headers: reply.headers, body: reply.body }
    }
}

export!(Whiteboard);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::fake::Fake;

    fn call(fake: &Fake, logged_in: bool, method: &str, path: &str) -> Reply {
        let user = backend::User { id: "u1".into(), username: "alice".into(), display_name: String::new() };
        let request = backend::Request { method: method.into(), path: path.into(), ..Default::default() };
        route(fake, logged_in.then_some(&user), &request)
    }

    #[test]
    fn serves_the_page_and_the_template() {
        let fake = Fake::user();
        for path in ["/edit", "/app.css", "/i18n.js", "/edit.js", "/templates/empty.excalidraw"] {
            assert_eq!(call(&fake, true, "GET", path).status, 200, "{path}");
        }
        let template = call(&fake, true, "GET", "/templates/empty.excalidraw");
        let scene: serde_json::Value = serde_json::from_slice(&template.body).unwrap();
        assert_eq!(scene["type"], "excalidraw");
        assert_eq!(call(&fake, true, "GET", "/nothing").status, 404);
    }

    #[test]
    fn page_routes_need_the_user_not_a_token() {
        let fake = Fake::user();
        assert_eq!(call(&fake, false, "GET", "/status").status, 401);
        assert_eq!(call(&fake, false, "POST", "/session").status, 401);
        assert_eq!(call(&fake, true, "GET", "/status").status, 200);
        // The board's token opens the file's routes, nothing else.
        let board = Fake::default();
        assert_eq!(call(&board, true, "GET", "/status").status, 403);
        assert_eq!(call(&board, true, "POST", "/session").status, 403);
        assert_eq!(call(&board, false, "GET", "/board/x").status, 401);
    }
}
