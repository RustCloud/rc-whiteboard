//! The whiteboard service: serves the board (Excalidraw, built from
//! `../frontend` into the binary) under `/whiteboard/`. Browsers reach it only
//! through the cloud's address (the plugin's `[[proxy]]`), so the board runs
//! on the cloud's origin and talks to the plugin's routes with its token.
//!
//! No state and no settings but `LISTEN` (default `0.0.0.0:8080`).
//! `rc-whiteboard-service --health` asks a running one whether it answers
//! (the image's health check: it has no shell or curl).

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

use axum::body::Body;
use axum::extract::Path;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use rust_embed::RustEmbed;
use tower_http::compression::CompressionLayer;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const PREFIX: &str = "/whiteboard";

/// The built board: `../frontend/dist` (`npm run build`).
#[derive(RustEmbed)]
#[folder = "../frontend/dist"]
#[allow_missing = true]
struct Board;

/// What the board may do on the cloud's origin: its own scripts and styles,
/// pictures from the board itself, requests to the cloud (the plugin's routes)
/// only. `wasm-unsafe-eval`: Excalidraw subsets fonts with WebAssembly when it
/// exports. `frame-src https:`: embedded web pages (YouTube, …), which are
/// sandboxed by Excalidraw.
const CSP: &str = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; \
                   img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; \
                   frame-src https:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

fn app() -> Router {
    Router::new()
        .route(PREFIX, get(|| async { redirect() }))
        .route(&format!("{PREFIX}/"), get(|| async { file("index.html") }))
        .route(&format!("{PREFIX}/version"), get(version))
        .route(&format!("{PREFIX}/{{*path}}"), get(|Path(path): Path<String>| async move { file(&path) }))
        .fallback(|| async { (StatusCode::NOT_FOUND, "Not found") })
        .layer(CompressionLayer::new())
}

async fn version() -> Response {
    let body = serde_json::json!({ "name": "rc-whiteboard-service", "version": VERSION }).to_string();
    ([(header::CONTENT_TYPE, "application/json"), (header::CACHE_CONTROL, "no-store")], body).into_response()
}

fn redirect() -> Response {
    // Relative: the cloud's proxy keeps it on the cloud's address.
    (StatusCode::MOVED_PERMANENTLY, [(header::LOCATION, "/whiteboard/")]).into_response()
}

/// A file of the board. Names with a content hash (`assets/…-<hash>.js`)
/// never change: the browser keeps them; the rest it asks again.
fn file(path: &str) -> Response {
    let Some(found) = Board::get(path) else {
        if path == "index.html" {
            return (StatusCode::SERVICE_UNAVAILABLE, "The board is not built into this service (frontend/dist)")
                .into_response();
        }
        return (StatusCode::NOT_FOUND, "Not found").into_response();
    };
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    let cache = if path.starts_with("assets/") || path.starts_with("fonts/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    let mut response = Response::new(Body::from(found.data.into_owned()));
    let headers = response.headers_mut();
    let content_type = match mime.type_() {
        mime_guess::mime::TEXT | mime_guess::mime::JAVASCRIPT => format!("{mime}; charset=utf-8"),
        _ => mime.to_string(),
    };
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_str(&content_type).expect("a mime type"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    if path.ends_with(".html") {
        headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(CSP));
    }
    response
}

fn listen_address() -> SocketAddr {
    let value = std::env::var("LISTEN").unwrap_or_else(|_| "0.0.0.0:8080".into());
    value.parse().unwrap_or_else(|_| panic!("LISTEN is not an address: {value}"))
}

/// `--health`: whether the service on `LISTEN` answers (exit code 0 or 1).
fn health() -> bool {
    let mut address = listen_address();
    if address.ip().is_unspecified() {
        address.set_ip([127, 0, 0, 1].into());
    }
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_secs(3)) else { return false };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let request = format!("GET {PREFIX}/version HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    let mut answer = String::new();
    stream.write_all(request.as_bytes()).is_ok()
        && stream.read_to_string(&mut answer).is_ok()
        && answer.starts_with("HTTP/1.1 200")
}

#[tokio::main]
async fn main() {
    if std::env::args().nth(1).as_deref() == Some("--health") {
        std::process::exit(if health() { 0 } else { 1 });
    }
    let address = listen_address();
    let listener = tokio::net::TcpListener::bind(address).await.expect("listen");
    let built = if Board::get("index.html").is_some() { "" } else { " (no board built in!)" };
    println!("rc-whiteboard-service {VERSION} on http://{address}{PREFIX}/{built}");
    axum::serve(listener, app())
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .expect("serve");
}

#[cfg(test)]
mod tests {
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    use super::*;

    async fn get(path: &str) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
        let response = app().oneshot(Request::get(path).body(Body::empty()).unwrap()).await.unwrap();
        let (parts, body) = response.into_parts();
        (parts.status, parts.headers, body.collect().await.unwrap().to_bytes().to_vec())
    }

    #[tokio::test]
    async fn tells_its_version() {
        let (status, headers, body) = get("/whiteboard/version").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers[header::CONTENT_TYPE], "application/json");
        let info: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(info["version"], VERSION);
    }

    #[tokio::test]
    async fn serves_the_board_only_under_its_path() {
        let (status, headers, _) = get("/whiteboard").await;
        assert_eq!(
            (status, &headers[header::LOCATION]),
            (StatusCode::MOVED_PERMANENTLY, &"/whiteboard/".parse::<HeaderValue>().unwrap())
        );
        let (status, headers, _) = get("/whiteboard/").await;
        if Board::get("index.html").is_some() {
            assert_eq!(status, StatusCode::OK);
            assert_eq!(headers[header::CACHE_CONTROL], "no-cache");
            assert!(headers[header::CONTENT_SECURITY_POLICY].to_str().unwrap().contains("frame-ancestors 'self'"));
        } else {
            assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        }
        assert_eq!(get("/whiteboard/assets/nothing.js").await.0, StatusCode::NOT_FOUND);
        assert_eq!(get("/whiteboard/../Cargo.toml").await.0, StatusCode::NOT_FOUND);
        assert_eq!(get("/").await.0, StatusCode::NOT_FOUND);
        assert_eq!(get("/other").await.0, StatusCode::NOT_FOUND);
    }
}
