//! The local MCP server: lets a coding agent on this machine read what Studio
//! knows (the APIs in the library, their operations, environments, mocks).
//!
//! It is off until the user starts it, runs only while Studio is open, and:
//!
//!  - listens on `127.0.0.1` only, never on another interface;
//!  - answers only requests carrying the per-install bearer token;
//!  - rejects any `Host` other than `127.0.0.1:<port>` / `localhost:<port>` and
//!    any browser `Origin`, so a web page can't reach it through DNS rebinding.
//!
//! This is a small hand-written subset of MCP's Streamable HTTP transport:
//! one `POST /mcp` endpoint, one JSON-RPC request per HTTP request, a plain
//! JSON response, no sessions and no server-sent events. That is all a server
//! with a fixed tool list needs, and it keeps the shell free of a web framework.
//!
//! Tool logic lives in two places, on purpose:
//!
//!  - `list_environments` is answered here, from `environments.json` alone. It
//!    never touches the credential store, and secret values are dropped here, so
//!    no bug in the interface can make one come back.
//!  - Every other tool is handed to the web view (`studio://mcp-call`) and
//!    answered by `src/lib/mcp.ts`, which already parses specs and talks to
//!    Spec0. The web view replies through `mcp_respond`.
//!
//! Nothing in this module sends a network request.

use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;
use tauri::{Emitter, Manager};

/// The port tried first. If it's taken, the next few are tried in turn.
pub const DEFAULT_PORT: u16 = 47321;
const PORT_ATTEMPTS: u16 = 10;
/// The one endpoint.
pub const ENDPOINT: &str = "/mcp";
/// Protocol revisions this server speaks, newest first.
pub const SUPPORTED_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26"];
/// The tool list, shared with the interface so the two can't disagree.
const TOOLS_JSON: &str = include_str!("../../src/lib/mcp-tools.json");
/// The web view is asked to run a tool with this event.
pub const CALL_EVENT: &str = "studio://mcp-call";
/// Tool calls answered in Rust, for the window's console: name and outcome only.
pub const ACTIVITY_EVENT: &str = "studio://mcp-activity";

const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_BODY_BYTES: usize = 1024 * 1024;
const MAX_CONNECTIONS: usize = 16;
const MIN_TOKEN_LEN: usize = 32;
/// Creating a mock can take a while; reading a spec never does.
const CALL_TIMEOUT: Duration = Duration::from_secs(90);
const IO_TIMEOUT: Duration = Duration::from_secs(15);

const INSTRUCTIONS: &str = "Spec0 Studio's local MCP server. It shares what Studio holds on this \
machine: the APIs in the user's library (including specs that aren't published anywhere), their \
operations and servers, the user's environments (secret values are never shared), and hosted mock \
servers when the user is signed in to Spec0. Studio does not send requests for you: use \
get_operation or get_mock_server to get a URL, then call it yourself, for example with curl. To \
search every API in the user's organisation, use the remote Spec0 MCP server; \
get_connection_status gives its address.";

// ── HTTP ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default)]
pub struct HttpRequest {
    pub method: String,
    /// The path without its query string.
    pub path: String,
    /// The query string without its `?`; empty when there is none.
    pub query: String,
    /// Header names lower-cased.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl HttpRequest {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub body: String,
}

impl HttpResponse {
    fn text(status: u16, body: &str) -> Self {
        Self {
            status,
            headers: vec![("Content-Type", "text/plain; charset=utf-8".into())],
            body: format!("{body}\n"),
        }
    }

    fn json(status: u16, body: &Value) -> Self {
        Self {
            status,
            headers: vec![("Content-Type", "application/json".into())],
            body: body.to_string(),
        }
    }

    fn empty(status: u16) -> Self {
        Self { status, headers: vec![], body: String::new() }
    }

    fn with_header(mut self, name: &'static str, value: &str) -> Self {
        self.headers.push((name, value.into()));
        self
    }

    fn to_bytes(&self) -> Vec<u8> {
        let mut out = format!("HTTP/1.1 {} {}\r\n", self.status, reason(self.status));
        for (name, value) in &self.headers {
            out.push_str(&format!("{name}: {value}\r\n"));
        }
        out.push_str(&format!(
            "Content-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
            self.body.len()
        ));
        let mut bytes = out.into_bytes();
        bytes.extend_from_slice(self.body.as_bytes());
        bytes
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        411 => "Length Required",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        431 => "Request Header Fields Too Large",
        503 => "Service Unavailable",
        _ => "Error",
    }
}

/// Read one HTTP/1.1 request. Errors come back as the response to send.
pub fn read_request(stream: &mut impl Read) -> Result<HttpRequest, HttpResponse> {
    let mut buffer: Vec<u8> = Vec::with_capacity(2048);
    let mut chunk = [0u8; 2048];
    let header_end = loop {
        if let Some(position) = find(&buffer, b"\r\n\r\n") {
            break position;
        }
        if buffer.len() > MAX_HEADER_BYTES {
            return Err(HttpResponse::text(431, "Headers too large."));
        }
        let read = stream
            .read(&mut chunk)
            .map_err(|_| HttpResponse::text(408, "Timed out reading the request."))?;
        if read == 0 {
            return Err(HttpResponse::text(400, "Incomplete request."));
        }
        buffer.extend_from_slice(&chunk[..read]);
    };

    let head = String::from_utf8_lossy(&buffer[..header_end]).into_owned();
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("");
    let (path, query) = match target.split_once('?') {
        Some((path, query)) => (path.to_string(), query.to_string()),
        None => (target.to_string(), String::new()),
    };
    if method.is_empty() || path.is_empty() {
        return Err(HttpResponse::text(400, "Malformed request line."));
    }

    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string()))
        .collect();

    let mut request = HttpRequest { method, path, query, headers, body: Vec::new() };

    if request.header("transfer-encoding").is_some() {
        return Err(HttpResponse::text(411, "Send a Content-Length; chunked bodies aren't accepted."));
    }
    let length = match request.header("content-length") {
        None => 0,
        Some(raw) => raw
            .parse::<usize>()
            .map_err(|_| HttpResponse::text(400, "Invalid Content-Length."))?,
    };
    if length > MAX_BODY_BYTES {
        return Err(HttpResponse::text(413, "Request body too large."));
    }

    let mut body = buffer[header_end + 4..].to_vec();
    while body.len() < length {
        let read = stream
            .read(&mut chunk)
            .map_err(|_| HttpResponse::text(408, "Timed out reading the request."))?;
        if read == 0 {
            return Err(HttpResponse::text(400, "Incomplete request body."));
        }
        body.extend_from_slice(&chunk[..read]);
    }
    body.truncate(length);
    request.body = body;
    Ok(request)
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|window| window == needle)
}

// ── the checks ───────────────────────────────────────────────────────────────

/// Only our own loopback address. A page on another site that rebinds its DNS
/// to 127.0.0.1 still sends its own host name here, and is refused.
pub fn host_allowed(host: Option<&str>, port: u16) -> bool {
    let Some(host) = host else { return false };
    let host = host.trim().to_ascii_lowercase();
    host == format!("127.0.0.1:{port}") || host == format!("localhost:{port}")
}

/// Agents (CLI tools, editors) send no `Origin`. A browser always does, and no
/// page is served from this address, so any origin other than our own is a web
/// page trying to reach the server and is refused.
pub fn origin_allowed(origin: Option<&str>, port: u16) -> bool {
    match origin {
        None => true,
        Some(origin) => {
            let origin = origin.trim().to_ascii_lowercase();
            origin == format!("http://127.0.0.1:{port}") || origin == format!("http://localhost:{port}")
        }
    }
}

/// `Authorization: Bearer <token>`, compared in constant time.
pub fn authorized(header: Option<&str>, token: &str) -> bool {
    let Some(header) = header else { return false };
    let Some((scheme, presented)) = header.trim().split_once(' ') else { return false };
    if !scheme.eq_ignore_ascii_case("bearer") || token.is_empty() {
        return false;
    }
    constant_time_eq(presented.trim().as_bytes(), token.as_bytes())
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

// ── JSON-RPC ─────────────────────────────────────────────────────────────────

/// Runs the tools that aren't answered in Rust. The real one asks the web view.
pub trait ToolHost: Send + Sync {
    fn call(&self, name: &str, arguments: &Value) -> Result<Value, String>;
    /// Tells the window's console that a call answered here (not forwarded)
    /// happened: the tool's name and whether it worked. Never its arguments.
    fn note(&self, _name: &str, _ok: bool) {}
}

pub struct Config {
    pub port: u16,
    pub token: String,
    /// The app's config directory, where `environments.json` lives.
    pub config_dir: PathBuf,
    pub studio_version: String,
}

fn rpc_error(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// The whole request pipeline, independent of sockets so it can be tested.
pub fn handle(request: &HttpRequest, config: &Config, host: &dyn ToolHost) -> HttpResponse {
    if !host_allowed(request.header("host"), config.port) {
        return HttpResponse::text(403, "Host not allowed.");
    }
    if !origin_allowed(request.header("origin"), config.port) {
        return HttpResponse::text(403, "Origin not allowed. Browsers can't use this server.");
    }
    if request.path != ENDPOINT {
        return HttpResponse::text(404, "Not found. The MCP endpoint is /mcp.");
    }
    if !authorized(request.header("authorization"), &config.token) {
        return HttpResponse::text(401, "Missing or wrong token. Copy it from Studio's MCP settings.")
            .with_header("WWW-Authenticate", "Bearer realm=\"spec0-studio\"");
    }
    if request.method != "POST" {
        // No server-sent event stream and no sessions to delete.
        return HttpResponse::text(405, "Only POST is supported.").with_header("Allow", "POST");
    }
    let content_type = request.header("content-type").unwrap_or("").to_ascii_lowercase();
    if !content_type.starts_with("application/json") {
        return HttpResponse::text(415, "Send application/json.");
    }

    let message: Value = match serde_json::from_slice(&request.body) {
        Ok(value) => value,
        Err(_) => return HttpResponse::json(400, &rpc_error(&Value::Null, -32700, "Parse error")),
    };
    let Some(object) = message.as_object() else {
        return HttpResponse::json(
            400,
            &rpc_error(&Value::Null, -32600, "Invalid request: send one JSON-RPC object (no batches)."),
        );
    };

    // A notification or a response from the client: nothing to answer.
    let Some(method) = object.get("method").and_then(Value::as_str) else {
        return HttpResponse::empty(202);
    };
    let Some(id) = object.get("id") else {
        return HttpResponse::empty(202);
    };
    if !(id.is_string() || id.is_number()) {
        return HttpResponse::json(400, &rpc_error(&Value::Null, -32600, "Invalid request id."));
    }

    // After initialize, clients send the version they agreed on. One we don't
    // speak (a newer revision) gets a plain 400, which tells a client that
    // supports older revisions to fall back to the initialize handshake.
    if method != "initialize" {
        if let Some(version) = request.header("mcp-protocol-version") {
            if !SUPPORTED_VERSIONS.contains(&version.trim()) {
                return HttpResponse::json(
                    400,
                    &rpc_error(id, -32600, &format!("Unsupported MCP-Protocol-Version: {version}")),
                );
            }
        }
    }

    let empty = Value::Object(Map::new());
    let params = object.get("params").unwrap_or(&empty);
    let body = match dispatch(method, params, config, host) {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, message)) => rpc_error(id, code, &message),
    };
    HttpResponse::json(200, &body)
}

fn dispatch(
    method: &str,
    params: &Value,
    config: &Config,
    host: &dyn ToolHost,
) -> Result<Value, (i64, String)> {
    match method {
        "initialize" => {
            let requested = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
            let version = if SUPPORTED_VERSIONS.contains(&requested) {
                requested
            } else {
                SUPPORTED_VERSIONS[0]
            };
            Ok(json!({
                "protocolVersion": version,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": {
                    "name": "spec0-studio",
                    "title": "Spec0 Studio",
                    "version": config.studio_version,
                },
                "instructions": INSTRUCTIONS,
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tool_list() })),
        "tools/call" => {
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .ok_or((-32602, "Missing tool name.".to_string()))?;
            if !tool_names().iter().any(|known| known == name) {
                host.note(name, false);
                return Err((-32602, format!("Unknown tool: {name}")));
            }
            let arguments = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            if !arguments.is_object() {
                return Err((-32602, "Tool arguments must be an object.".to_string()));
            }
            if name == "list_environments" {
                host.note(name, true);
                return Ok(list_environments(&config.config_dir));
            }
            Ok(match host.call(name, &arguments) {
                Ok(result) if is_tool_result(&result) => result,
                Ok(_) => tool_error("Studio returned something that isn't a tool result."),
                Err(message) => tool_error(&message),
            })
        }
        _ => Err((-32601, format!("Method not found: {method}"))),
    }
}

fn tool_definitions() -> Vec<Value> {
    serde_json::from_str::<Vec<Value>>(TOOLS_JSON).unwrap_or_default()
}

fn tool_names() -> Vec<String> {
    tool_definitions()
        .iter()
        .filter_map(|tool| tool.get("name").and_then(Value::as_str).map(String::from))
        .collect()
}

/// What `tools/list` returns: the shared definitions without Studio's own field.
fn tool_list() -> Vec<Value> {
    tool_definitions()
        .into_iter()
        .map(|mut tool| {
            if let Some(object) = tool.as_object_mut() {
                object.remove("requiresSignIn");
            }
            tool
        })
        .collect()
}

fn is_tool_result(value: &Value) -> bool {
    value.get("content").map(Value::is_array).unwrap_or(false)
}

fn tool_text(text: &str, is_error: bool) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

fn tool_error(message: &str) -> Value {
    tool_text(message, true)
}

// ── list_environments ────────────────────────────────────────────────────────

const ENVIRONMENTS_FILE: &str = "environments.json";

/// Names, which one is active, and values for ordinary variables only.
///
/// Reads the committable file the interface writes, which already leaves secret
/// values out, and drops the value of anything marked secret regardless, so a
/// value that ended up in the file by some other path still stays here.
pub fn summarize_environments(raw: Option<&str>) -> Value {
    let file: Value = raw.and_then(|raw| serde_json::from_str(raw).ok()).unwrap_or(Value::Null);
    let active_id = file.get("activeId").and_then(Value::as_str);
    let environments: Vec<Value> = file
        .get("environments")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .map(|env| {
                    let id = env.get("id").and_then(Value::as_str);
                    let variables: Vec<Value> = env
                        .get("variables")
                        .and_then(Value::as_array)
                        .map(|vars| {
                            vars.iter()
                                .map(|variable| {
                                    let name = variable.get("name").and_then(Value::as_str).unwrap_or("");
                                    if variable.get("secret").and_then(Value::as_bool).unwrap_or(false) {
                                        json!({ "name": name, "secret": true, "value": "(secret, not shared)" })
                                    } else {
                                        let value = variable.get("value").and_then(Value::as_str).unwrap_or("");
                                        json!({ "name": name, "secret": false, "value": value })
                                    }
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    json!({
                        "name": env.get("name").and_then(Value::as_str).unwrap_or(""),
                        "active": id.is_some() && id == active_id,
                        "variables": variables,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let active = environments
        .iter()
        .find(|env| env["active"] == Value::Bool(true))
        .and_then(|env| env["name"].as_str())
        .map(String::from);

    json!({
        "activeEnvironment": active,
        "environments": environments,
        "note": "Studio fills in {{name}} from the active environment when it sends a request. Secret values are never shared over MCP; ask the user if you need one.",
    })
}

fn list_environments(config_dir: &Path) -> Value {
    let raw = std::fs::read_to_string(config_dir.join(ENVIRONMENTS_FILE)).ok();
    let summary = summarize_environments(raw.as_deref());
    tool_text(&serde_json::to_string_pretty(&summary).unwrap_or_default(), false)
}

// ── the server ───────────────────────────────────────────────────────────────

struct Running {
    port: u16,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

static SERVER: Mutex<Option<Running>> = Mutex::new(None);
static PENDING: Mutex<Option<HashMap<u64, mpsc::Sender<Value>>>> = Mutex::new(None);
static NEXT_CALL: AtomicU64 = AtomicU64::new(1);
static ACTIVE: AtomicUsize = AtomicUsize::new(0);

/// Asks the web view to run a tool and waits for `mcp_respond`.
struct WebviewHost {
    app: tauri::AppHandle,
}

impl ToolHost for WebviewHost {
    fn call(&self, name: &str, arguments: &Value) -> Result<Value, String> {
        let id = NEXT_CALL.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = mpsc::channel();
        with_pending(|pending| {
            pending.insert(id, sender);
        });
        let payload = json!({ "id": id, "name": name, "arguments": arguments });
        if let Err(error) = self.app.emit(CALL_EVENT, payload) {
            with_pending(|pending| {
                pending.remove(&id);
            });
            return Err(format!("Couldn't reach Studio's window: {error}"));
        }
        let result = receiver.recv_timeout(CALL_TIMEOUT);
        with_pending(|pending| {
            pending.remove(&id);
        });
        result.map_err(|_| "Studio didn't answer in time. Is its window open?".to_string())
    }

    fn note(&self, name: &str, ok: bool) {
        // Best effort: the console is a convenience, and a closed window just misses it.
        let _ = self.app.emit(ACTIVITY_EVENT, json!({ "name": name, "ok": ok }));
    }
}

fn with_pending<T>(work: impl FnOnce(&mut HashMap<u64, mpsc::Sender<Value>>) -> T) -> T {
    let mut guard = PENDING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    work(guard.get_or_insert_with(HashMap::new))
}

/// Bind the first free port from `start`, on the loopback address only.
fn bind(start: u16) -> Result<(TcpListener, u16), String> {
    let mut last_error = String::new();
    for offset in 0..PORT_ATTEMPTS {
        let Some(port) = start.checked_add(offset) else { break };
        match TcpListener::bind(("127.0.0.1", port)) {
            Ok(listener) => return Ok((listener, port)),
            Err(error) => last_error = error.to_string(),
        }
    }
    Err(format!(
        "Ports {start}–{} on 127.0.0.1 are all in use ({last_error}). Choose another port.",
        start.saturating_add(PORT_ATTEMPTS - 1)
    ))
}

fn serve_connection(mut stream: TcpStream, config: &Config, host: &dyn ToolHost) {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
    let response = match read_request(&mut stream) {
        Ok(request) => handle(&request, config, host),
        Err(response) => response,
    };
    let _ = stream.write_all(&response.to_bytes());
    let _ = stream.flush();
}

fn accept_loop(listener: TcpListener, stop: Arc<AtomicBool>, config: Arc<Config>, host: Arc<dyn ToolHost>) {
    while !stop.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok((mut stream, _)) => {
                if ACTIVE.load(Ordering::Relaxed) >= MAX_CONNECTIONS {
                    let _ = stream.set_nonblocking(false);
                    let _ = stream.write_all(&HttpResponse::text(503, "Busy. Try again.").to_bytes());
                    continue;
                }
                ACTIVE.fetch_add(1, Ordering::Relaxed);
                let config = Arc::clone(&config);
                let host = Arc::clone(&host);
                std::thread::spawn(move || {
                    serve_connection(stream, &config, host.as_ref());
                    ACTIVE.fetch_sub(1, Ordering::Relaxed);
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(40));
            }
            Err(_) => std::thread::sleep(Duration::from_millis(40)),
        }
    }
}

fn stop_server() {
    let running = SERVER.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take();
    if let Some(mut running) = running {
        running.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = running.thread.take() {
            let _ = thread.join();
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub running: bool,
    pub port: Option<u16>,
}

fn status() -> McpStatus {
    let guard = SERVER.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    McpStatus { running: guard.is_some(), port: guard.as_ref().map(|running| running.port) }
}

/// Start (or restart) the server. `port` is where to start looking.
#[tauri::command]
pub fn mcp_start(app: tauri::AppHandle, port: Option<u16>, token: String) -> Result<McpStatus, String> {
    if token.len() < MIN_TOKEN_LEN {
        return Err("The token is too short. Generate a new one.".into());
    }
    let start = port.unwrap_or(DEFAULT_PORT);
    if start < 1024 {
        return Err("Choose a port from 1024 up.".into());
    }
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("no app config dir: {error}"))?;

    stop_server();
    let (listener, bound) = bind(start)?;
    listener.set_nonblocking(true).map_err(|error| error.to_string())?;

    let config = Arc::new(Config {
        port: bound,
        token,
        config_dir,
        studio_version: app.package_info().version.to_string(),
    });
    let host: Arc<dyn ToolHost> = Arc::new(WebviewHost { app: app.clone() });
    let stop = Arc::new(AtomicBool::new(false));
    let thread = {
        let stop = Arc::clone(&stop);
        std::thread::spawn(move || accept_loop(listener, stop, config, host))
    };
    *SERVER.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) =
        Some(Running { port: bound, stop, thread: Some(thread) });
    Ok(status())
}

#[tauri::command]
pub fn mcp_stop() -> McpStatus {
    stop_server();
    status()
}

#[tauri::command]
pub fn mcp_status() -> McpStatus {
    status()
}

/// The web view's answer to a `studio://mcp-call`.
#[tauri::command]
pub fn mcp_respond(id: u64, result: Value) {
    if let Some(sender) = with_pending(|pending| pending.remove(&id)) {
        let _ = sender.send(result);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    const TOKEN: &str = "tok_0123456789abcdefghijklmnopqrstuvwxyz";
    const PORT: u16 = 47321;

    struct FakeHost;
    impl ToolHost for FakeHost {
        fn call(&self, name: &str, arguments: &Value) -> Result<Value, String> {
            if name == "get_api_spec" && arguments.get("api").is_none() {
                return Err("api is required".into());
            }
            Ok(json!({ "content": [{ "type": "text", "text": format!("ran {name}") }] }))
        }
    }

    fn config(dir: &Path) -> Config {
        Config {
            port: PORT,
            token: TOKEN.into(),
            config_dir: dir.to_path_buf(),
            studio_version: "0.2.0".into(),
        }
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("studio-mcp-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn post(body: &Value) -> HttpRequest {
        HttpRequest {
            method: "POST".into(),
            path: "/mcp".into(),
            query: String::new(),
            headers: vec![
                ("host".into(), format!("127.0.0.1:{PORT}")),
                ("authorization".into(), format!("Bearer {TOKEN}")),
                ("content-type".into(), "application/json".into()),
                ("accept".into(), "application/json, text/event-stream".into()),
            ],
            body: body.to_string().into_bytes(),
        }
    }

    fn set_header(request: &mut HttpRequest, name: &str, value: Option<&str>) {
        request.headers.retain(|(key, _)| key != name);
        if let Some(value) = value {
            request.headers.push((name.into(), value.into()));
        }
    }

    fn rpc(request: &HttpRequest, dir: &Path) -> (u16, Value) {
        let response = handle(request, &config(dir), &FakeHost);
        let body = serde_json::from_str(&response.body).unwrap_or(Value::Null);
        (response.status, body)
    }

    // ── auth and origin ──────────────────────────────────────────────────────

    #[test]
    fn requests_without_the_right_token_are_rejected() {
        let dir = temp_dir("auth");
        let message = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" });

        let mut request = post(&message);
        set_header(&mut request, "authorization", None);
        let response = handle(&request, &config(&dir), &FakeHost);
        assert_eq!(response.status, 401);
        assert!(response.headers.iter().any(|(name, _)| *name == "WWW-Authenticate"));

        for wrong in [
            "Bearer nope",
            "Bearer ",
            "Basic dG9rOnRvaw==",
            TOKEN,
            &format!("Bearer {TOKEN}x"),
            &format!("Bearer {}", &TOKEN[..TOKEN.len() - 1]),
        ] {
            set_header(&mut request, "authorization", Some(wrong));
            assert_eq!(handle(&request, &config(&dir), &FakeHost).status, 401, "{wrong}");
        }

        set_header(&mut request, "authorization", Some(&format!("bearer {TOKEN}")));
        assert_eq!(handle(&request, &config(&dir), &FakeHost).status, 200);
    }

    #[test]
    fn an_empty_configured_token_never_matches() {
        assert!(!authorized(Some("Bearer "), ""));
        assert!(!authorized(Some("Bearer x"), ""));
    }

    #[test]
    fn host_must_be_our_loopback_address() {
        assert!(host_allowed(Some("127.0.0.1:47321"), PORT));
        assert!(host_allowed(Some("localhost:47321"), PORT));
        assert!(host_allowed(Some("LOCALHOST:47321"), PORT));
        assert!(!host_allowed(None, PORT));
        assert!(!host_allowed(Some("127.0.0.1"), PORT));
        assert!(!host_allowed(Some("127.0.0.1:1234"), PORT));
        // DNS rebinding: the attacker's name resolves to 127.0.0.1, but the
        // browser still sends the attacker's name as Host.
        assert!(!host_allowed(Some("evil.example:47321"), PORT));
        assert!(!host_allowed(Some("127.0.0.1.evil.example:47321"), PORT));

        let dir = temp_dir("host");
        let mut request = post(&json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }));
        set_header(&mut request, "host", Some("evil.example:47321"));
        assert_eq!(handle(&request, &config(&dir), &FakeHost).status, 403);
    }

    #[test]
    fn browser_origins_are_rejected() {
        assert!(origin_allowed(None, PORT));
        assert!(origin_allowed(Some("http://127.0.0.1:47321"), PORT));
        assert!(!origin_allowed(Some("https://evil.example"), PORT));
        assert!(!origin_allowed(Some("null"), PORT));
        assert!(!origin_allowed(Some("http://localhost:3000"), PORT));

        let dir = temp_dir("origin");
        let mut request = post(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }));
        // Even with the token: a page must not be able to use a leaked token.
        set_header(&mut request, "origin", Some("https://evil.example"));
        assert_eq!(handle(&request, &config(&dir), &FakeHost).status, 403);
    }

    #[test]
    fn other_paths_and_methods() {
        let dir = temp_dir("paths");
        let mut request = post(&json!({}));
        request.path = "/".into();
        assert_eq!(handle(&request, &config(&dir), &FakeHost).status, 404);

        let mut request = post(&json!({}));
        request.method = "GET".into();
        let response = handle(&request, &config(&dir), &FakeHost);
        assert_eq!(response.status, 405);
        assert!(response.headers.contains(&("Allow", "POST".into())));

        let mut request = post(&json!({}));
        set_header(&mut request, "content-type", Some("text/plain"));
        assert_eq!(handle(&request, &config(&dir), &FakeHost).status, 415);
    }

    // ── JSON-RPC ─────────────────────────────────────────────────────────────

    #[test]
    fn initialize_negotiates_a_version() {
        let dir = temp_dir("init");
        let (status, body) = rpc(
            &post(&json!({
                "jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "t", "version": "1" } }
            })),
            &dir,
        );
        assert_eq!(status, 200);
        assert_eq!(body["id"], 1);
        assert_eq!(body["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(body["result"]["serverInfo"]["name"], "spec0-studio");
        assert_eq!(body["result"]["serverInfo"]["version"], "0.2.0");
        assert!(body["result"]["capabilities"]["tools"].is_object());

        // An unknown version gets our newest one back.
        let (_, body) = rpc(
            &post(&json!({ "jsonrpc": "2.0", "id": "a", "method": "initialize", "params": { "protocolVersion": "1999-01-01" } })),
            &dir,
        );
        assert_eq!(body["id"], "a");
        assert_eq!(body["result"]["protocolVersion"], SUPPORTED_VERSIONS[0]);
    }

    #[test]
    fn notifications_are_accepted_without_a_body() {
        let dir = temp_dir("notify");
        let response = handle(
            &post(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })),
            &config(&dir),
            &FakeHost,
        );
        assert_eq!(response.status, 202);
        assert!(response.body.is_empty());
    }

    #[test]
    fn tools_list_matches_the_shared_definitions() {
        let dir = temp_dir("list");
        let (status, body) = rpc(&post(&json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })), &dir);
        assert_eq!(status, 200);
        let tools = body["result"]["tools"].as_array().unwrap();
        let names: Vec<&str> = tools.iter().map(|tool| tool["name"].as_str().unwrap()).collect();
        for expected in [
            "list_local_apis",
            "get_api_spec",
            "get_operation",
            "search_operations",
            "get_connection_status",
            "list_environments",
            "get_mock_server",
            "create_mock_server",
            "refresh_mock_server",
        ] {
            assert!(names.contains(&expected), "missing {expected}");
        }
        for tool in tools {
            assert!(tool["description"].as_str().unwrap().len() > 40);
            assert_eq!(tool["inputSchema"]["type"], "object");
            // Studio's own marker stays out of the protocol.
            assert!(tool.get("requiresSignIn").is_none());
        }
    }

    #[test]
    fn tools_call_forwards_and_reports_errors_as_tool_results() {
        let dir = temp_dir("call");
        let (status, body) = rpc(
            &post(&json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "list_local_apis", "arguments": {} } })),
            &dir,
        );
        assert_eq!(status, 200);
        assert_eq!(body["result"]["content"][0]["text"], "ran list_local_apis");

        // A failure inside a tool is a result the model can read, not a protocol error.
        let (_, body) = rpc(
            &post(&json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "get_api_spec", "arguments": {} } })),
            &dir,
        );
        assert_eq!(body["result"]["isError"], true);
        assert_eq!(body["result"]["content"][0]["text"], "api is required");

        let (_, body) = rpc(
            &post(&json!({ "jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": { "name": "send_request" } })),
            &dir,
        );
        assert_eq!(body["error"]["code"], -32602);

        let (_, body) = rpc(
            &post(&json!({ "jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": { "name": "get_operation", "arguments": [1] } })),
            &dir,
        );
        assert_eq!(body["error"]["code"], -32602);
    }

    #[test]
    fn protocol_errors() {
        let dir = temp_dir("errors");
        let (status, body) = rpc(&post(&json!({ "jsonrpc": "2.0", "id": 7, "method": "resources/list" })), &dir);
        assert_eq!(status, 200);
        assert_eq!(body["error"]["code"], -32601);

        let mut request = post(&json!({}));
        request.body = b"{not json".to_vec();
        let (status, body) = rpc(&request, &dir);
        assert_eq!(status, 400);
        assert_eq!(body["error"]["code"], -32700);

        let (status, body) = rpc(&post(&json!([{ "jsonrpc": "2.0", "id": 1, "method": "ping" }])), &dir);
        assert_eq!(status, 400);
        assert_eq!(body["error"]["code"], -32600);

        let mut request = post(&json!({ "jsonrpc": "2.0", "id": 8, "method": "tools/list" }));
        set_header(&mut request, "mcp-protocol-version", Some("2099-01-01"));
        assert_eq!(rpc(&request, &dir).0, 400);
        set_header(&mut request, "mcp-protocol-version", Some("2025-06-18"));
        assert_eq!(rpc(&request, &dir).0, 200);
    }

    // ── environments ─────────────────────────────────────────────────────────

    #[test]
    fn list_environments_never_returns_secret_values() {
        // A file where a secret value somehow got written: it still stays here.
        let raw = json!({
            "activeId": "env_b",
            "environments": [
                { "id": "env_a", "name": "Local", "variables": [
                    { "name": "baseUrl", "value": "http://localhost:8080", "secret": false },
                    { "name": "token", "value": "sk_live_should_not_leak", "secret": true }
                ]},
                { "id": "env_b", "name": "Staging", "variables": [
                    { "name": "password", "value": "hunter2", "secret": true },
                    { "name": "orderId", "value": "42", "secret": false }
                ]}
            ]
        })
        .to_string();

        let summary = summarize_environments(Some(&raw));
        let text = summary.to_string();
        assert!(!text.contains("sk_live_should_not_leak"));
        assert!(!text.contains("hunter2"));
        assert!(text.contains("http://localhost:8080"));
        assert_eq!(summary["activeEnvironment"], "Staging");
        assert_eq!(summary["environments"][0]["variables"][1]["name"], "token");
        assert_eq!(summary["environments"][0]["variables"][1]["secret"], true);

        // And through the whole pipeline, from the file on disk.
        let dir = temp_dir("envs");
        std::fs::write(dir.join(ENVIRONMENTS_FILE), &raw).unwrap();
        let response = handle(
            &post(&json!({ "jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": { "name": "list_environments" } })),
            &config(&dir),
            &FakeHost,
        );
        assert_eq!(response.status, 200);
        assert!(!response.body.contains("sk_live_should_not_leak"));
        assert!(!response.body.contains("hunter2"));
        assert!(response.body.contains("orderId"));
    }

    #[test]
    fn list_environments_without_a_file() {
        let summary = summarize_environments(None);
        assert_eq!(summary["environments"], json!([]));
        assert_eq!(summary["activeEnvironment"], Value::Null);
    }

    // ── HTTP parsing and the socket ─────────────────────────────────────────

    #[test]
    fn reads_a_request_with_a_body() {
        let raw = "POST /mcp?x=1 HTTP/1.1\r\nHost: 127.0.0.1:47321\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}";
        let request = read_request(&mut Cursor::new(raw.as_bytes().to_vec())).unwrap();
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/mcp");
        assert_eq!(request.query, "x=1");
        assert_eq!(request.header("host"), Some("127.0.0.1:47321"));
        assert_eq!(request.body, b"{}");

        let chunked = "POST /mcp HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n";
        assert_eq!(read_request(&mut Cursor::new(chunked.as_bytes().to_vec())).unwrap_err().status, 411);

        let huge = format!("POST /mcp HTTP/1.1\r\nContent-Length: {}\r\n\r\n", MAX_BODY_BYTES + 1);
        assert_eq!(read_request(&mut Cursor::new(huge.into_bytes())).unwrap_err().status, 413);
    }

    #[test]
    fn binds_loopback_and_falls_back_when_the_port_is_taken() {
        let (first, port) = bind(DEFAULT_PORT + 200).unwrap();
        assert!(first.local_addr().unwrap().ip().is_loopback());
        let (_second, next) = bind(port).unwrap();
        assert_ne!(port, next);
        assert!(next > port && next < port + PORT_ATTEMPTS);
    }

    #[test]
    fn serves_over_a_real_socket() {
        let dir = temp_dir("socket");
        let (listener, port) = bind(DEFAULT_PORT + 300).unwrap();
        listener.set_nonblocking(true).unwrap();
        let config = Arc::new(Config { port, ..config(&dir) });
        let stop = Arc::new(AtomicBool::new(false));
        let thread = {
            let stop = Arc::clone(&stop);
            let host: Arc<dyn ToolHost> = Arc::new(FakeHost);
            std::thread::spawn(move || accept_loop(listener, stop, config, host))
        };

        let send = |auth: Option<&str>| -> String {
            let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }).to_string();
            let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
            let auth = auth.map(|token| format!("Authorization: Bearer {token}\r\n")).unwrap_or_default();
            write!(
                stream,
                "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{auth}Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).unwrap();
            response
        };

        assert!(send(Some(TOKEN)).starts_with("HTTP/1.1 200"));
        assert!(send(None).starts_with("HTTP/1.1 401"));

        stop.store(true, Ordering::Relaxed);
        thread.join().unwrap();
    }

    #[test]
    fn calls_answered_here_are_noted_without_arguments() {
        use std::sync::Mutex as StdMutex;
        struct Recording(StdMutex<Vec<(String, bool)>>);
        impl ToolHost for Recording {
            fn call(&self, _name: &str, _arguments: &Value) -> Result<Value, String> {
                Ok(json!({ "content": [] }))
            }
            fn note(&self, name: &str, ok: bool) {
                self.0.lock().unwrap().push((name.to_string(), ok));
            }
        }
        let dir = temp_dir("note");
        let host = Recording(StdMutex::new(Vec::new()));
        let call = |name: &str| {
            let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": name, "arguments": { "secret": "sk_live_x" } } });
            handle(&post(&body), &config(&dir), &host);
        };
        call("list_environments");
        call("no_such_tool");
        let noted = host.0.lock().unwrap().clone();
        assert_eq!(noted, vec![("list_environments".to_string(), true), ("no_such_tool".to_string(), false)]);
        let _ = std::fs::remove_dir_all(dir);
    }
}
