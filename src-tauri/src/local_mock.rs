//! Local mocks: serve an API from the library on this computer, one port per API.
//!
//! Off until the user starts one, and gone when Studio quits. Each mock:
//!
//!  - listens on `127.0.0.1` only, never on another interface;
//!  - answers only a `Host` that names the loopback address (`127.0.0.1`,
//!    `localhost` or `[::1]`, any port), so a web page can't reach it by
//!    rebinding its own DNS name to 127.0.0.1;
//!  - answers browsers only from pages served by this computer: an `Origin` of
//!    `http(s)://localhost`, `127.0.0.1` or `[::1]` on any port gets CORS
//!    headers, and any other origin, `null` included, is refused before the
//!    request goes anywhere. A website you happen to have open must not be able
//!    to read your specs through the mock, or even find out which ones you're
//!    serving. Tools that send no `Origin` (curl, a backend, Studio itself) are
//!    answered as usual.
//!
//! This module owns the socket and those checks, and answers CORS preflights
//! itself. Every other request is handed to the web view as a
//! `studio://local-mock-request` event and answered by `src/lib/localMock.ts`,
//! which already parses specs and generates examples; the reply comes back
//! through `local_mock_respond`. The listener is the same small hand-written
//! HTTP/1.1 reader as the MCP server's (`mcp::read_request`), one request per
//! connection, on plain threads.
//!
//! Nothing in this module sends a network request.

use crate::mcp::{read_request, HttpRequest};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::io::Write;
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;
use tauri::Emitter;

/// The ports tried for an API that has no remembered port, in order.
pub const FIRST_PORT: u16 = 4010;
pub const LAST_PORT: u16 = 4099;
/// The web view is asked to answer a request with this event.
pub const REQUEST_EVENT: &str = "studio://local-mock-request";

const MAX_CONNECTIONS: usize = 64;
const ANSWER_TIMEOUT: Duration = Duration::from_secs(10);
const IO_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_ID_LEN: usize = 128;
const PREFLIGHT_METHODS: &str = "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS";
/// Response headers the web view may not set: Rust frames the response itself.
const RESERVED_HEADERS: &[&str] = &[
    "content-length",
    "connection",
    "transfer-encoding",
    "keep-alive",
    "upgrade",
    "trailer",
    "access-control-allow-origin",
    "access-control-allow-credentials",
    "access-control-allow-methods",
    "access-control-allow-headers",
    "access-control-expose-headers",
    "access-control-max-age",
    "access-control-allow-private-network",
];

// ── responses ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct MockResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl MockResponse {
    fn json(status: u16, body: &Value) -> Self {
        Self {
            status,
            headers: vec![("Content-Type".into(), "application/json".into())],
            body: body.to_string(),
        }
    }

    fn empty(status: u16) -> Self {
        Self { status, headers: vec![], body: String::new() }
    }

    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    fn with(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    fn to_bytes(&self, head: bool) -> Vec<u8> {
        let mut out = format!("HTTP/1.1 {} {}\r\n", self.status, reason(self.status));
        for (name, value) in &self.headers {
            out.push_str(&format!("{name}: {value}\r\n"));
        }
        if self.header("cache-control").is_none() {
            out.push_str("Cache-Control: no-store\r\n");
        }
        out.push_str(&format!("Content-Length: {}\r\nConnection: close\r\n\r\n", self.body.len()));
        let mut bytes = out.into_bytes();
        if !head {
            bytes.extend_from_slice(self.body.as_bytes());
        }
        bytes
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        100 => "Continue",
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        204 => "No Content",
        206 => "Partial Content",
        301 => "Moved Permanently",
        302 => "Found",
        303 => "See Other",
        304 => "Not Modified",
        307 => "Temporary Redirect",
        308 => "Permanent Redirect",
        400 => "Bad Request",
        401 => "Unauthorized",
        402 => "Payment Required",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        406 => "Not Acceptable",
        408 => "Request Timeout",
        409 => "Conflict",
        410 => "Gone",
        411 => "Length Required",
        412 => "Precondition Failed",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        418 => "I'm a teapot",
        422 => "Unprocessable Content",
        429 => "Too Many Requests",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "Status",
    }
}

// ── the checks ───────────────────────────────────────────────────────────────

/// Split `host[:port]`, keeping an IPv6 literal's brackets.
fn host_name(authority: &str) -> &str {
    if authority.starts_with('[') {
        return match authority.find(']') {
            Some(end) => &authority[..=end],
            None => authority,
        };
    }
    authority.split(':').next().unwrap_or("")
}

fn port_ok(authority: &str, name: &str) -> bool {
    let rest = &authority[name.len()..];
    rest.is_empty() || (rest.len() > 1 && rest.starts_with(':') && rest[1..].parse::<u16>().is_ok())
}

fn is_loopback_name(name: &str) -> bool {
    matches!(name, "127.0.0.1" | "localhost" | "[::1]")
}

/// The `Host` must name this computer. A page that rebinds its DNS name to
/// 127.0.0.1 still sends its own name here, and is refused. Any port is fine,
/// so a dev-server proxy that forwards its own `Host` still works.
pub fn host_allowed(host: Option<&str>) -> bool {
    let Some(host) = host else { return false };
    let host = host.trim().to_ascii_lowercase();
    let name = host_name(&host);
    is_loopback_name(name) && port_ok(&host, name)
}

/// A page served from this computer: `http(s)://localhost`, `127.0.0.1` or
/// `[::1]`, any port, nothing after it. Everything else is a website, and so is
/// `null` (a sandboxed frame or a file opened in the browser).
pub fn origin_allowed(origin: &str) -> bool {
    let origin = origin.trim().to_ascii_lowercase();
    let Some(authority) = origin.strip_prefix("http://").or_else(|| origin.strip_prefix("https://")) else {
        return false;
    };
    if authority.contains('/') || authority.contains('@') {
        return false;
    }
    let name = host_name(authority);
    is_loopback_name(name) && port_ok(authority, name)
}

/// A header list from a preflight's `Access-Control-Request-Headers`: tokens only.
fn safe_header_list(raw: &str) -> String {
    raw.split(',')
        .map(str::trim)
        .filter(|name| !name.is_empty() && name.bytes().all(is_token_byte))
        .collect::<Vec<_>>()
        .join(", ")
}

fn is_token_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte)
}

fn value_ok(value: &str) -> bool {
    value.bytes().all(|byte| byte == b'\t' || (0x20..0x7f).contains(&byte))
}

/// What happens to a request before any spec is consulted.
#[derive(Debug, PartialEq)]
pub enum Gate {
    /// Answered here: refused, or a CORS preflight.
    Answer(MockResponse),
    /// Goes to the web view. `cors` is the origin to allow, when there is one.
    Forward { cors: Option<String> },
}

pub fn gate(request: &HttpRequest) -> Gate {
    if !host_allowed(request.header("host")) {
        return Gate::Answer(MockResponse::json(
            403,
            &json!({ "error": "This local mock only answers requests addressed to 127.0.0.1 or localhost." }),
        ));
    }
    let origin = request.header("origin");
    if let Some(origin) = origin {
        if !origin_allowed(origin) {
            // No CORS headers: the page learns nothing, not even that this is a mock.
            return Gate::Answer(MockResponse::json(
                403,
                &json!({ "error": "This local mock only answers web pages served from localhost or 127.0.0.1." }),
            ));
        }
    }
    let preflight = request.method == "OPTIONS" && request.header("access-control-request-method").is_some();
    match (origin, preflight) {
        (Some(origin), true) => {
            let mut response = MockResponse::empty(204)
                .with("Access-Control-Allow-Origin", origin.trim())
                .with("Access-Control-Allow-Methods", PREFLIGHT_METHODS)
                .with("Access-Control-Allow-Credentials", "true")
                .with("Access-Control-Max-Age", "600")
                .with("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
            if let Some(asked) = request.header("access-control-request-headers") {
                let list = safe_header_list(asked);
                if !list.is_empty() {
                    response = response.with("Access-Control-Allow-Headers", &list);
                }
            }
            if request.header("access-control-request-private-network") == Some("true") {
                response = response.with("Access-Control-Allow-Private-Network", "true");
            }
            Gate::Answer(response)
        }
        (Some(origin), false) => Gate::Forward { cors: Some(origin.trim().to_string()) },
        (None, _) => Gate::Forward { cors: None },
    }
}

/// The web view's answer, made safe to write and given its CORS headers.
pub fn finish(answer: MockResponse, cors: Option<&str>) -> MockResponse {
    let status = if (100..=599).contains(&answer.status) { answer.status } else { 500 };
    let mut headers: Vec<(String, String)> = answer
        .headers
        .into_iter()
        .filter(|(name, value)| {
            !name.is_empty()
                && name.bytes().all(is_token_byte)
                && value_ok(value)
                && !RESERVED_HEADERS.contains(&name.to_ascii_lowercase().as_str())
        })
        .collect();
    if let Some(origin) = cors {
        let exposed: Vec<String> = headers
            .iter()
            .map(|(name, _)| name.clone())
            .filter(|name| !name.eq_ignore_ascii_case("content-type"))
            .collect();
        headers.push(("Access-Control-Allow-Origin".into(), origin.into()));
        headers.push(("Access-Control-Allow-Credentials".into(), "true".into()));
        headers.push(("Vary".into(), "Origin".into()));
        if !exposed.is_empty() {
            headers.push(("Access-Control-Expose-Headers".into(), exposed.join(", ")));
        }
    }
    let body = if status == 204 || status == 304 || status < 200 { String::new() } else { answer.body };
    MockResponse { status, headers, body }
}

/// Answers the requests that pass the checks. The real one asks the web view.
pub trait Answerer: Send + Sync {
    fn answer(&self, mock: &str, request: &HttpRequest) -> Result<MockResponse, String>;
}

/// The whole pipeline for one request, independent of sockets so it can be tested.
pub fn handle(request: &HttpRequest, mock: &str, answerer: &dyn Answerer) -> MockResponse {
    match gate(request) {
        Gate::Answer(response) => response,
        Gate::Forward { cors } => match answerer.answer(mock, request) {
            Ok(answer) => finish(answer, cors.as_deref()),
            Err(message) => finish(MockResponse::json(502, &json!({ "error": message })), cors.as_deref()),
        },
    }
}

// ── the servers ──────────────────────────────────────────────────────────────

struct Running {
    port: u16,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

static SERVERS: Mutex<Option<HashMap<String, Running>>> = Mutex::new(None);
static PENDING: Mutex<Option<HashMap<u64, mpsc::Sender<MockResponse>>>> = Mutex::new(None);
static NEXT_CALL: AtomicU64 = AtomicU64::new(1);
static ACTIVE: AtomicUsize = AtomicUsize::new(0);

fn with_servers<T>(work: impl FnOnce(&mut HashMap<String, Running>) -> T) -> T {
    let mut guard = SERVERS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    work(guard.get_or_insert_with(HashMap::new))
}

fn with_pending<T>(work: impl FnOnce(&mut HashMap<u64, mpsc::Sender<MockResponse>>) -> T) -> T {
    let mut guard = PENDING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    work(guard.get_or_insert_with(HashMap::new))
}

/// Asks the web view and waits for `local_mock_respond`.
struct WebviewAnswerer {
    app: tauri::AppHandle,
}

impl Answerer for WebviewAnswerer {
    fn answer(&self, mock: &str, request: &HttpRequest) -> Result<MockResponse, String> {
        let call = NEXT_CALL.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = mpsc::channel();
        with_pending(|pending| {
            pending.insert(call, sender);
        });
        let mut headers = Map::new();
        for (name, value) in &request.headers {
            let joined = match headers.get(name).and_then(Value::as_str) {
                Some(existing) => format!("{existing}, {value}"),
                None => value.clone(),
            };
            headers.insert(name.clone(), Value::String(joined));
        }
        let payload = json!({
            "call": call,
            "mock": mock,
            "method": request.method,
            "path": request.path,
            "query": request.query,
            "headers": headers,
            "body": String::from_utf8_lossy(&request.body),
        });
        if let Err(error) = self.app.emit(REQUEST_EVENT, payload) {
            with_pending(|pending| {
                pending.remove(&call);
            });
            return Err(format!("Couldn't reach Studio's window: {error}"));
        }
        let result = receiver.recv_timeout(ANSWER_TIMEOUT);
        with_pending(|pending| {
            pending.remove(&call);
        });
        result.map_err(|_| "Studio didn't answer in time. Is its window open?".to_string())
    }
}

fn try_bind(port: u16) -> Option<TcpListener> {
    TcpListener::bind(("127.0.0.1", port)).ok()
}

/// The remembered port if it's free, else the first free one in the range.
fn bind(preferred: Option<u16>, taken: &[u16]) -> Result<(TcpListener, u16), String> {
    if let Some(port) = preferred.filter(|port| *port >= 1024 && !taken.contains(port)) {
        if let Some(listener) = try_bind(port) {
            return Ok((listener, port));
        }
    }
    for port in FIRST_PORT..=LAST_PORT {
        if taken.contains(&port) {
            continue;
        }
        if let Some(listener) = try_bind(port) {
            return Ok((listener, port));
        }
    }
    Err(format!(
        "Ports {FIRST_PORT}–{LAST_PORT} on 127.0.0.1 are all in use. Stop another local mock or free a port."
    ))
}

fn serve_connection(mut stream: TcpStream, mock: &str, answerer: &dyn Answerer) {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
    let (response, head) = match read_request(&mut stream) {
        Ok(request) => (handle(&request, mock, answerer), request.method == "HEAD"),
        Err(error) => (MockResponse::json(error.status, &json!({ "error": error.body.trim() })), false),
    };
    let _ = stream.write_all(&response.to_bytes(head));
    let _ = stream.flush();
}

fn accept_loop(listener: TcpListener, stop: Arc<AtomicBool>, mock: Arc<String>, answerer: Arc<dyn Answerer>) {
    while !stop.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok((mut stream, _)) => {
                if ACTIVE.load(Ordering::Relaxed) >= MAX_CONNECTIONS {
                    let _ = stream.set_nonblocking(false);
                    let busy = MockResponse::json(503, &json!({ "error": "Busy. Try again." }));
                    let _ = stream.write_all(&busy.to_bytes(false));
                    continue;
                }
                ACTIVE.fetch_add(1, Ordering::Relaxed);
                let mock = Arc::clone(&mock);
                let answerer = Arc::clone(&answerer);
                std::thread::spawn(move || {
                    serve_connection(stream, &mock, answerer.as_ref());
                    ACTIVE.fetch_sub(1, Ordering::Relaxed);
                });
            }
            Err(_) => std::thread::sleep(Duration::from_millis(40)),
        }
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_ID_LEN && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalMockStatus {
    pub id: String,
    pub port: u16,
}

fn list() -> Vec<LocalMockStatus> {
    let mut out: Vec<LocalMockStatus> = with_servers(|servers| {
        servers
            .iter()
            .map(|(id, running)| LocalMockStatus { id: id.clone(), port: running.port })
            .collect()
    });
    out.sort_by_key(|status| status.port);
    out
}

fn start(id: &str, preferred: Option<u16>, answerer: Arc<dyn Answerer>) -> Result<LocalMockStatus, String> {
    if !valid_id(id) {
        return Err("Not a library id.".into());
    }
    // Hold the lock while binding, so two starts can't pick the same port.
    with_servers(|servers| {
        if let Some(running) = servers.get(id) {
            return Ok(LocalMockStatus { id: id.into(), port: running.port });
        }
        let taken: Vec<u16> = servers.values().map(|running| running.port).collect();
        let (listener, port) = bind(preferred, &taken)?;
        listener.set_nonblocking(true).map_err(|error| error.to_string())?;
        let stop = Arc::new(AtomicBool::new(false));
        let thread = {
            let stop = Arc::clone(&stop);
            let mock = Arc::new(id.to_string());
            std::thread::spawn(move || accept_loop(listener, stop, mock, answerer))
        };
        servers.insert(id.into(), Running { port, stop, thread: Some(thread) });
        Ok(LocalMockStatus { id: id.into(), port })
    })
}

fn stop(id: &str) {
    let running = with_servers(|servers| servers.remove(id));
    if let Some(mut running) = running {
        running.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = running.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Start serving one API. `port` is the one it had last time, if any.
#[tauri::command]
pub fn local_mock_start(app: tauri::AppHandle, id: String, port: Option<u16>) -> Result<LocalMockStatus, String> {
    start(&id, port, Arc::new(WebviewAnswerer { app }))
}

#[tauri::command]
pub fn local_mock_stop(id: String) {
    stop(&id);
}

#[tauri::command]
pub fn local_mock_list() -> Vec<LocalMockStatus> {
    list()
}

/// The web view's answer to a `studio://local-mock-request`.
#[tauri::command]
pub fn local_mock_respond(call: u64, response: MockResponse) {
    if let Some(sender) = with_pending(|pending| pending.remove(&call)) {
        let _ = sender.send(response);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    struct Echo;
    impl Answerer for Echo {
        fn answer(&self, mock: &str, request: &HttpRequest) -> Result<MockResponse, String> {
            Ok(MockResponse {
                status: 200,
                headers: vec![
                    ("Content-Type".into(), "application/json".into()),
                    ("X-Spec0-Mock-Operation".into(), format!("{} {}", request.method, request.path)),
                ],
                body: json!({ "mock": mock, "query": request.query }).to_string(),
            })
        }
    }

    struct Failing;
    impl Answerer for Failing {
        fn answer(&self, _: &str, _: &HttpRequest) -> Result<MockResponse, String> {
            Err("Studio didn't answer in time.".into())
        }
    }

    fn request(method: &str, headers: &[(&str, &str)]) -> HttpRequest {
        HttpRequest {
            method: method.into(),
            path: "/orders".into(),
            query: String::new(),
            headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            body: vec![],
        }
    }

    fn header<'a>(response: &'a MockResponse, name: &str) -> Option<&'a str> {
        response.header(name)
    }

    #[test]
    fn host_must_name_this_computer() {
        for good in ["127.0.0.1:4010", "localhost:4010", "LOCALHOST:5173", "[::1]:4010", "127.0.0.1", "localhost"] {
            assert!(host_allowed(Some(good)), "{good}");
        }
        for bad in [
            "evil.example:4010",
            "127.0.0.1.evil.example:4010",
            "localhost.evil.example",
            "localhost:abc",
            "localhost:",
            "0.0.0.0:4010",
            "",
        ] {
            assert!(!host_allowed(Some(bad)), "{bad}");
        }
        assert!(!host_allowed(None));

        let response = handle(&request("GET", &[("host", "evil.example:4010")]), "m", &Echo);
        assert_eq!(response.status, 403);
        assert!(header(&response, "access-control-allow-origin").is_none());
    }

    #[test]
    fn only_pages_on_this_computer_are_browser_origins_we_answer() {
        for good in [
            "http://localhost:3000",
            "http://localhost",
            "https://localhost:5173",
            "http://127.0.0.1:8080",
            "http://[::1]:3000",
        ] {
            assert!(origin_allowed(good), "{good}");
        }
        for bad in [
            "https://evil.example",
            "http://localhost.evil.example",
            "http://127.0.0.1.evil.example:3000",
            "http://evil.example:3000",
            "null",
            "file://",
            "http://localhost:3000/path",
            "http://user@localhost:3000",
            "http://localhost:99999",
            "tauri://localhost",
            "",
        ] {
            assert!(!origin_allowed(bad), "{bad}");
        }
    }

    #[test]
    fn a_preflight_from_localhost_is_allowed() {
        let response = handle(
            &request(
                "OPTIONS",
                &[
                    ("host", "127.0.0.1:4010"),
                    ("origin", "http://localhost:3000"),
                    ("access-control-request-method", "POST"),
                    ("access-control-request-headers", "content-type, x-mock-status, bad header\r\n"),
                ],
            ),
            "m",
            &Echo,
        );
        assert_eq!(response.status, 204);
        assert_eq!(header(&response, "access-control-allow-origin"), Some("http://localhost:3000"));
        assert_eq!(header(&response, "access-control-allow-headers"), Some("content-type, x-mock-status"));
        assert!(header(&response, "access-control-allow-methods").unwrap().contains("PATCH"));
        assert_eq!(header(&response, "access-control-allow-credentials"), Some("true"));
    }

    #[test]
    fn a_preflight_from_a_website_is_refused_without_cors_headers() {
        let response = handle(
            &request(
                "OPTIONS",
                &[
                    ("host", "127.0.0.1:4010"),
                    ("origin", "https://evil.example"),
                    ("access-control-request-method", "GET"),
                ],
            ),
            "m",
            &Echo,
        );
        assert_eq!(response.status, 403);
        assert!(response.headers.iter().all(|(name, _)| !name.to_ascii_lowercase().starts_with("access-control")));
    }

    #[test]
    fn a_website_cant_send_simple_requests_either() {
        // A GET needs no preflight, so refusing only preflights would still let a
        // page trigger requests. It's refused before the spec is consulted.
        let response = handle(
            &request("GET", &[("host", "127.0.0.1:4010"), ("origin", "https://evil.example")]),
            "m",
            &Echo,
        );
        assert_eq!(response.status, 403);
        assert!(!response.body.contains("\"mock\""));
    }

    #[test]
    fn requests_without_an_origin_are_answered_without_cors() {
        let response = handle(&request("GET", &[("host", "127.0.0.1:4010")]), "sample_1", &Echo);
        assert_eq!(response.status, 200);
        assert!(response.body.contains("sample_1"));
        assert!(header(&response, "access-control-allow-origin").is_none());
    }

    #[test]
    fn answers_to_localhost_pages_carry_cors_headers() {
        let response = handle(
            &request("GET", &[("host", "localhost:4010"), ("origin", "http://localhost:5173")]),
            "m",
            &Echo,
        );
        assert_eq!(response.status, 200);
        assert_eq!(header(&response, "access-control-allow-origin"), Some("http://localhost:5173"));
        assert_eq!(header(&response, "access-control-expose-headers"), Some("X-Spec0-Mock-Operation"));
        assert_eq!(header(&response, "vary"), Some("Origin"));
    }

    #[test]
    fn the_web_view_cant_break_the_framing_or_widen_cors() {
        let answer = MockResponse {
            status: 204,
            headers: vec![
                ("Content-Length".into(), "999".into()),
                ("X-Ok".into(), "fine".into()),
                ("X-Split".into(), "a\r\nSet-Cookie: x=1".into()),
                ("Bad Name".into(), "x".into()),
                ("Access-Control-Allow-Origin".into(), "*".into()),
            ],
            body: "should not be sent".into(),
        };
        let finished = finish(answer, None);
        assert_eq!(finished.headers, vec![("X-Ok".to_string(), "fine".to_string())]);
        assert!(finished.body.is_empty());
        assert_eq!(finish(MockResponse::empty(42), None).status, 500);
    }

    #[test]
    fn a_missing_answer_is_a_readable_502() {
        let response = handle(&request("GET", &[("host", "127.0.0.1:4010")]), "m", &Failing);
        assert_eq!(response.status, 502);
        assert!(response.body.contains("didn't answer"));
    }

    #[test]
    fn head_responses_have_no_body_but_keep_the_length() {
        let bytes = MockResponse::json(200, &json!({ "a": 1 })).to_bytes(true);
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.contains("Content-Length: 7\r\n"));
        assert!(text.ends_with("\r\n\r\n"));
    }

    #[test]
    fn ids_are_library_ids_only() {
        assert!(valid_id("sample_1x9z"));
        assert!(valid_id("file_abc-12"));
        assert!(!valid_id(""));
        assert!(!valid_id("../etc"));
        assert!(!valid_id(&"a".repeat(MAX_ID_LEN + 1)));
    }

    #[test]
    fn binds_loopback_prefers_the_remembered_port_and_skips_taken_ones() {
        let (first, port) = bind(Some(47_900), &[]).unwrap();
        assert_eq!(port, 47_900);
        assert!(first.local_addr().unwrap().ip().is_loopback());
        // Busy (held by `first`): falls back into the range.
        let (_second, next) = bind(Some(47_900), &[]).unwrap();
        assert!((FIRST_PORT..=LAST_PORT).contains(&next));
        // A port another mock holds is never tried.
        let (_third, other) = bind(Some(next), &[next]).unwrap();
        assert_ne!(other, next);
    }

    #[test]
    fn serves_several_mocks_over_real_sockets_and_stops() {
        let a = start("test_a", Some(47_910), Arc::new(Echo)).unwrap();
        let b = start("test_b", Some(47_911), Arc::new(Echo)).unwrap();
        assert_ne!(a.port, b.port);
        // Starting a running mock again keeps its port.
        assert_eq!(start("test_a", None, Arc::new(Echo)).unwrap(), a);
        assert!(list().contains(&a));

        let send = |port: u16, raw: &str| -> String {
            let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
            stream.write_all(raw.replace("PORT", &port.to_string()).as_bytes()).unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).unwrap();
            response
        };

        let ok = send(a.port, "GET /orders?limit=2 HTTP/1.1\r\nHost: 127.0.0.1:PORT\r\n\r\n");
        assert!(ok.starts_with("HTTP/1.1 200 OK"), "{ok}");
        assert!(ok.contains("\"mock\":\"test_a\""));
        assert!(ok.contains("limit=2"));
        let other = send(b.port, "GET / HTTP/1.1\r\nHost: localhost:PORT\r\n\r\n");
        assert!(other.contains("\"mock\":\"test_b\""));
        let refused = send(a.port, "GET / HTTP/1.1\r\nHost: evil.example\r\n\r\n");
        assert!(refused.starts_with("HTTP/1.1 403"));

        stop("test_a");
        stop("test_b");
        assert!(!list().iter().any(|status| status.id.starts_with("test_")));
        assert!(TcpStream::connect(("127.0.0.1", a.port)).is_err());
    }
}
