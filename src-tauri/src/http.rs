//! Outbound HTTP.
//!
//! Why this exists rather than `tauri-plugin-http`: that plugin forwards the
//! webview's origin (`tauri://localhost`) as an `Origin` header on every request.
//! Any server with CORS configured then treats the call as a cross-origin browser
//! request and rejects it (Spring answers `403 Invalid CORS request`).
//!
//! A desktop client is not a browser and has no origin, so it sends no `Origin`
//! header at all. Requests are built here with exactly the headers the caller
//! asked for and nothing else. This is also where per-request timeout, redirect
//! policy, proxy and certificate trust live: the things that decide whether
//! Studio works on a corporate network at all.

use crate::cookies::Jar;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// How TLS certificates are verified for one request.
#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TlsConfig {
    /// PEM bundle to trust *in addition to* the system roots. The safe way to
    /// reach a host behind a private CA: verification still happens, against a
    /// root the user deliberately supplied.
    #[serde(default)]
    ca_bundle_pem: Option<String>,
    /// Skip verification entirely. Not a default, and the UI is responsible for
    /// saying so at send time. A client that quietly stops checking
    /// certificates is worse than one that fails loudly.
    #[serde(default)]
    insecure: bool,
}

#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProxyConfig {
    /// Explicit proxy URL. When absent, the process environment
    /// (`HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`) is honoured, the same thing every
    /// other CLI on the machine does, which is what a developer expects.
    #[serde(default)]
    url: Option<String>,
    /// Hosts to bypass an explicit proxy for. The environment's own `NO_PROXY`
    /// still applies when no explicit URL is set.
    #[serde(default)]
    no_proxy: Option<String>,
    /// Send nothing through a proxy, ignoring the environment too.
    #[serde(default)]
    disabled: bool,
}

/// One part of a multipart body.
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MultipartPart {
    name: String,
    /// A literal value, for a text part.
    #[serde(default)]
    value: Option<String>,
    /// A file on disk, read here rather than shipped over IPC.
    ///
    /// The alternative (base64 through the JSON bridge) inflates every upload
    /// by a third and holds the whole file in the webview's heap. A path plus a
    /// streaming read keeps a 200MB upload the same cost as a 200KB one, and the
    /// file dialog was already the consent step for reading it.
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    file_name: Option<String>,
    #[serde(default)]
    content_type: Option<String>,
}

/// What to send as the request body.
///
/// A tagged union rather than a string because `multipart/form-data` cannot be
/// represented as one: it needs real bytes and a boundary the client generates.
#[derive(Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RequestBody {
    /// Sent verbatim. JSON, XML, plain text: anything already serialised.
    Text { text: String },
    /// `application/x-www-form-urlencoded`, encoded here so repeated keys work.
    Form { fields: Vec<(String, String)> },
    Multipart { parts: Vec<MultipartPart> },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    method: String,
    url: String,
    #[serde(default)]
    headers: HashMap<String, String>,
    #[serde(default)]
    body: Option<RequestBody>,
    #[serde(default)]
    timeout_ms: Option<u64>,
    /// Which cookie jar to use. Jars are per-API (`None` = no cookies at all), so
    /// a session picked up from one API's host is never offered to another's.
    #[serde(default)]
    jar: Option<String>,
    #[serde(default)]
    follow_redirects: Option<bool>,
    #[serde(default)]
    tls: Option<TlsConfig>,
    #[serde(default)]
    proxy: Option<ProxyConfig>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    status: u16,
    status_text: String,
    headers: HashMap<String, String>,
    /// The body decoded as text. Empty when the response wasn't text (see
    /// `body_path`), so a PDF isn't mangled into replacement characters.
    body: String,
    /// True when the payload isn't text and `body` is therefore not the content.
    binary: bool,
    content_type: String,
    /// Size in bytes as received, whether text or not.
    byte_length: usize,
    /// Where the raw bytes were written, for binary responses.
    ///
    /// Written to a temp file rather than returned inline: a 40MB download must
    /// not cross the IPC bridge as base64 just so it can be saved to disk a
    /// moment later.
    body_path: Option<String>,
    /// Small binary payloads, base64, so an image can be shown without a second
    /// round trip. Absent above the preview cap.
    preview_base64: Option<String>,
    ms: u64,
    /// URLs passed through on the way here. Empty when nothing redirected, so a
    /// 302 that silently changed the destination becomes visible instead of
    /// being implied by a response that doesn't match what was asked for.
    redirects: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CookieRow {
    name: String,
    value: String,
    domain: String,
    path: String,
    /// RFC 3339, or absent for a session cookie.
    expires: Option<String>,
    secure: bool,
    http_only: bool,
}

/// Cookie jars, one per API.
///
/// A single shared jar would hand a session from one API's host to another's on
/// any redirect that crossed between them: a quiet credential leak between two
/// things the user thinks of as unrelated. Keyed by the library entry's id.
fn jars() -> &'static Mutex<HashMap<String, Arc<Jar>>> {
    static JARS: OnceLock<Mutex<HashMap<String, Arc<Jar>>>> = OnceLock::new();
    JARS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn jar_for(key: &str) -> Arc<Jar> {
    let mut all = jars().lock().expect("cookie jar registry poisoned");
    all.entry(key.to_string())
        .or_insert_with(|| Arc::new(Jar::default()))
        .clone()
}

#[tauri::command]
pub async fn http_send(request: HttpRequest) -> Result<HttpResponse, String> {
    let method = reqwest::Method::from_bytes(request.method.to_uppercase().as_bytes())
        .map_err(|_| format!("unsupported HTTP method: {}", request.method))?;

    // No default headers: notably no Origin, and no compression negotiation the
    // caller didn't ask for.
    let mut client = reqwest::Client::builder()
        .timeout(Duration::from_millis(request.timeout_ms.unwrap_or(30_000)));

    // Record the hops rather than only following them: reqwest won't say
    // afterwards where it went, so the policy closure is the only place to look.
    let trail: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    if request.follow_redirects.unwrap_or(true) {
        let seen = trail.clone();
        client = client.redirect(reqwest::redirect::Policy::custom(move |attempt| {
            if let Ok(mut hops) = seen.lock() {
                hops.push(attempt.url().to_string());
            }
            if attempt.previous().len() >= 10 {
                attempt.error("too many redirects (stopped at 10)")
            } else {
                attempt.follow()
            }
        }));
    } else {
        client = client.redirect(reqwest::redirect::Policy::none());
    }

    let tls = request.tls.unwrap_or_default();
    if let Some(pem) = tls.ca_bundle_pem.as_deref().filter(|p| !p.trim().is_empty()) {
        // Additive: the system roots still apply, so trusting a private CA
        // doesn't quietly stop the rest of the internet from being verified.
        for certificate in reqwest::Certificate::from_pem_bundle(pem.as_bytes())
            .map_err(|error| format!("that CA bundle isn't valid PEM: {error}"))?
        {
            client = client.add_root_certificate(certificate);
        }
    }
    if tls.insecure {
        client = client.danger_accept_invalid_certs(true);
    }

    let proxy = request.proxy.unwrap_or_default();
    if proxy.disabled {
        client = client.no_proxy();
    } else if let Some(url) = proxy.url.as_deref().filter(|u| !u.trim().is_empty()) {
        let mut configured = reqwest::Proxy::all(url)
            .map_err(|error| format!("that proxy URL isn't usable: {error}"))?;
        if let Some(list) = proxy.no_proxy.as_deref().filter(|l| !l.trim().is_empty()) {
            if let Some(bypass) = reqwest::NoProxy::from_string(list) {
                configured = configured.no_proxy(Some(bypass));
            }
        }
        client = client.proxy(configured);
    }
    // Otherwise reqwest's own environment detection applies, which already
    // honours HTTPS_PROXY / HTTP_PROXY / NO_PROXY. Left alone deliberately: a
    // developer expects this to behave like every other tool on the machine.

    if let Some(store) = request.jar.as_deref().map(jar_for) {
        client = client.cookie_provider(store);
    }

    let client = client.build().map_err(|error| error.to_string())?;

    let mut outgoing = client.request(method, &request.url);
    for (name, value) in &request.headers {
        outgoing = outgoing.header(name, value);
    }
    if let Some(body) = request.body {
        outgoing = apply_body(outgoing, body)?;
    }

    let started = Instant::now();
    let response = outgoing.send().await.map_err(|error| {
        // reqwest's Display is terse; surface the source chain so a TLS or DNS
        // failure doesn't just read "error sending request".
        let mut message = error.to_string();
        let mut source = std::error::Error::source(&error);
        while let Some(inner) = source {
            message.push_str(&format!(": {inner}"));
            source = inner.source();
        }
        if is_certificate_failure(&message) {
            message.push_str(
                "\n\nIf this host uses a private or self-signed certificate, add its CA \
                 bundle or trust the host in Connection settings.",
            );
        }
        message
    })?;

    let status = response.status();
    let status_text = status.canonical_reason().unwrap_or("").to_string();

    let mut headers = HashMap::new();
    for (name, value) in response.headers() {
        if let Ok(text) = value.to_str() {
            headers.insert(name.as_str().to_ascii_lowercase(), text.to_string());
        }
    }

    let content_type = headers.get("content-type").cloned().unwrap_or_default();
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    let ms = started.elapsed().as_millis() as u64;
    let redirects = trail.lock().map(|hops| hops.clone()).unwrap_or_default();
    let decoded = decode_body(&bytes, &content_type)?;

    Ok(HttpResponse {
        status: status.as_u16(),
        status_text,
        headers,
        body: decoded.text,
        binary: decoded.binary,
        content_type,
        byte_length: bytes.len(),
        body_path: decoded.path,
        preview_base64: decoded.preview,
        ms,
        redirects,
    })
}

/// Inline preview cap. Above this an image is offered as a file rather than
/// base64'd across the bridge; a 30MB PNG would cost 40MB of string to show.
const PREVIEW_LIMIT: usize = 2 * 1024 * 1024;

struct DecodedBody {
    text: String,
    binary: bool,
    path: Option<String>,
    preview: Option<String>,
}

/// Decide whether a payload is text, and keep the bytes either way.
///
/// Content-type is the first signal but not the last: servers mislabel, and
/// `application/octet-stream` is routinely used for JSON. So a payload that
/// decodes cleanly as UTF-8 and doesn't contain NULs is treated as text
/// regardless of what the header claimed. Being wrong here means showing
/// someone replacement characters instead of their response.
fn decode_body(bytes: &[u8], content_type: &str) -> Result<DecodedBody, String> {
    let declared_text = is_textual_type(content_type);
    let decoded = std::str::from_utf8(bytes).ok();
    let looks_text = decoded.is_some_and(|text| !text.contains('\0'));

    if declared_text || looks_text {
        return Ok(DecodedBody {
            text: decoded.unwrap_or_default().to_string(),
            binary: false,
            path: None,
            preview: None,
        });
    }

    // Binary: keep the bytes on disk so "Save as…" is a copy, not a re-download.
    let mut path = std::env::temp_dir();
    path.push(format!(
        "spec0-studio-response-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::write(&path, bytes)
        .map_err(|error| format!("couldn't hold the response body: {error}"))?;

    let preview = (bytes.len() <= PREVIEW_LIMIT).then(|| {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(bytes)
    });

    Ok(DecodedBody {
        text: String::new(),
        binary: true,
        path: Some(path.to_string_lossy().into_owned()),
        preview,
    })
}

fn is_textual_type(content_type: &str) -> bool {
    let lowered = content_type.to_ascii_lowercase();
    lowered.starts_with("text/")
        || lowered.contains("json")
        || lowered.contains("xml")
        || lowered.contains("javascript")
        || lowered.contains("x-www-form-urlencoded")
        || lowered.contains("csv")
        || lowered.contains("yaml")
}

/// Attach the body, in whichever form it takes.
fn apply_body(
    builder: reqwest::RequestBuilder,
    body: RequestBody,
) -> Result<reqwest::RequestBuilder, String> {
    match body {
        RequestBody::Text { text } => Ok(builder.body(text)),
        // `form` sets the content type and encodes repeated keys correctly;
        // hand-encoding this is where round-tripping a list of values goes wrong.
        RequestBody::Form { fields } => Ok(builder.form(&fields)),
        RequestBody::Multipart { parts } => {
            let mut form = reqwest::multipart::Form::new();
            for part in parts {
                if let Some(path) = part.path.as_deref().filter(|p| !p.is_empty()) {
                    let contents = std::fs::read(path)
                        .map_err(|error| format!("couldn't read {path}: {error}"))?;
                    let name = part
                        .file_name
                        .clone()
                        .or_else(|| {
                            std::path::Path::new(path)
                                .file_name()
                                .map(|n| n.to_string_lossy().into_owned())
                        })
                        .unwrap_or_else(|| "file".into());
                    let mut file_part = reqwest::multipart::Part::bytes(contents).file_name(name);
                    if let Some(mime) = part.content_type.as_deref().filter(|m| !m.is_empty()) {
                        file_part = file_part
                            .mime_str(mime)
                            .map_err(|error| format!("{mime} isn't a usable content type: {error}"))?;
                    }
                    form = form.part(part.name, file_part);
                } else {
                    let mut text_part =
                        reqwest::multipart::Part::text(part.value.unwrap_or_default());
                    if let Some(mime) = part.content_type.as_deref().filter(|m| !m.is_empty()) {
                        text_part = text_part
                            .mime_str(mime)
                            .map_err(|error| format!("{mime} isn't a usable content type: {error}"))?;
                    }
                    form = form.part(part.name, text_part);
                }
            }
            // Deliberately not setting Content-Type: reqwest writes it with the
            // boundary it generated, and a caller-supplied one would be wrong.
            Ok(builder.multipart(form))
        }
    }
}

/// Copy a held response body to where the user asked for it.
#[tauri::command]
pub fn save_response(from: String, to: String) -> Result<(), String> {
    std::fs::copy(&from, &to)
        .map(|_| ())
        .map_err(|error| format!("couldn't save to {to}: {error}"))
}

/// What an API's jar is holding, so a session isn't an invisible variable.
#[tauri::command]
pub fn cookies_list(jar: String) -> Vec<CookieRow> {
    let store = jar_for(&jar);
    let guard = match store.lock() {
        Ok(guard) => guard,
        Err(_) => return Vec::new(),
    };
    guard
        .iter_any()
        .map(|cookie| CookieRow {
            name: cookie.name().to_string(),
            value: cookie.value().to_string(),
            domain: cookie.domain().unwrap_or_default().to_string(),
            path: cookie.path().unwrap_or("/").to_string(),
            expires: cookie.expires_datetime().map(|at| at.to_string()),
            secure: cookie.secure().unwrap_or(false),
            http_only: cookie.http_only().unwrap_or(false),
        })
        .collect()
}

#[tauri::command]
pub fn cookies_clear(jar: String) {
    let store = jar_for(&jar);
    // Bound rather than used inline: the `if let` scrutinee's temporary would
    // outlive `store` and the borrow checker rejects it.
    let locked = store.lock();
    if let Ok(mut guard) = locked {
        guard.clear();
    }
}

/// Is this failure about certificate trust rather than reachability?
///
/// Matched on the message because rustls surfaces these through several distinct
/// error types while the useful hint is the same for all of them. A false
/// positive costs one extra sentence; a false negative costs a confused hour.
fn is_certificate_failure(message: &str) -> bool {
    let lowered = message.to_ascii_lowercase();
    [
        "certificate",
        "self-signed",
        "self signed",
        "unknownissuer",
        "invalid peer",
    ]
    .iter()
    .any(|needle| lowered.contains(needle))
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::cookie::CookieStore as _;
    use reqwest::header::HeaderValue;

    #[test]
    fn jars_are_per_api_and_not_shared() {
        let a = jar_for("api-a");
        let b = jar_for("api-b");
        // The point of the whole per-API scheme: a session from one API's host
        // must never be offered to another's.
        assert!(!Arc::ptr_eq(&a, &b), "two APIs must not share a jar");
        assert!(Arc::ptr_eq(&a, &jar_for("api-a")), "one API must reuse its jar");
    }

    #[test]
    fn a_stored_cookie_comes_back_for_the_same_host_only() {
        let jar = jar_for("cookie-roundtrip");
        let target: url::Url = "https://api.example.com/orders".parse().unwrap();
        let elsewhere: url::Url = "https://other.example.org/orders".parse().unwrap();

        let header = HeaderValue::from_static("session=abc123; Path=/");
        jar.set_cookies(&mut [&header].into_iter(), &target);

        assert_eq!(
            jar.cookies(&target).map(|v| v.to_str().unwrap().to_string()),
            Some("session=abc123".to_string())
        );
        assert!(
            jar.cookies(&elsewhere).is_none(),
            "a cookie set by one host must not be sent to an unrelated one"
        );
    }

    #[test]
    fn clearing_one_jar_leaves_the_others_alone() {
        let header = HeaderValue::from_static("session=abc; Path=/");
        let url: url::Url = "https://a.example.com/".parse().unwrap();
        for key in ["clear-a", "clear-b"] {
            jar_for(key).set_cookies(&mut [&header].into_iter(), &url);
        }

        cookies_clear("clear-a".into());

        assert!(cookies_list("clear-a".into()).is_empty());
        assert_eq!(
            cookies_list("clear-b".into()).len(),
            1,
            "clearing one API's session must not sign the user out of another"
        );
    }

    #[test]
    fn json_mislabelled_as_octet_stream_is_still_shown_as_text() {
        // Servers mislabel constantly, and application/octet-stream is routinely
        // used for JSON. Trusting the header here means showing someone
        // replacement characters instead of their response.
        let decoded = decode_body(br#"{"ok":true}"#, "application/octet-stream").unwrap();
        assert!(!decoded.binary);
        assert_eq!(decoded.text, r#"{"ok":true}"#);
        assert!(decoded.path.is_none(), "text must not be spilled to disk");
    }

    #[test]
    fn real_binary_is_kept_as_bytes_not_mangled_into_text() {
        // A PNG header: invalid UTF-8, and contains NULs.
        let png = [0x89u8, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0xFF];
        let decoded = decode_body(&png, "image/png").unwrap();
        assert!(decoded.binary);
        assert!(decoded.text.is_empty());
        let path = decoded.path.expect("binary bodies are held on disk for Save as…");
        assert_eq!(std::fs::read(&path).unwrap(), png);
        assert!(decoded.preview.is_some(), "small images preview inline");
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn text_that_declares_itself_text_is_never_treated_as_binary() {
        let decoded = decode_body("héllo → arrow".as_bytes(), "text/plain; charset=utf-8").unwrap();
        assert!(!decoded.binary);
        assert_eq!(decoded.text, "héllo → arrow");
    }

    #[test]
    fn textual_types_are_recognised_beyond_text_slash() {
        for kind in [
            "application/json",
            "application/problem+json",
            "text/csv",
            "application/xml",
            "application/x-yaml",
        ] {
            assert!(is_textual_type(kind), "{kind} should be textual");
        }
        for kind in ["image/png", "application/pdf", "application/zip"] {
            assert!(!is_textual_type(kind), "{kind} should not be textual");
        }
    }

    /// Accept exactly one request on a free port and hand back its raw bytes.
    ///
    /// In-process rather than against a fixture server, so the test is
    /// self-contained: no port to reserve, nothing to start, nothing to leak.
    fn capture_one_request() -> (u16, std::sync::mpsc::Receiver<Vec<u8>>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut seen = Vec::new();
                let mut buffer = [0u8; 8192];
                // Read until the client stops sending; the body is what matters.
                stream
                    .set_read_timeout(Some(Duration::from_millis(400)))
                    .ok();
                while let Ok(n) = stream.read(&mut buffer) {
                    if n == 0 {
                        break;
                    }
                    seen.extend_from_slice(&buffer[..n]);
                }
                stream
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}")
                    .ok();
                let _ = tx.send(seen);
            }
        });
        (port, rx)
    }

    #[test]
    fn a_multipart_body_sends_the_file_from_disk_with_a_generated_boundary() {
        let file = std::env::temp_dir().join("spec0-studio-multipart-test.txt");
        std::fs::write(&file, b"hello from a file").unwrap();

        let (port, rx) = capture_one_request();
        let request = HttpRequest {
            method: "POST".into(),
            url: format!("http://127.0.0.1:{port}/avatars"),
            headers: HashMap::new(),
            body: Some(RequestBody::Multipart {
                parts: vec![
                    MultipartPart {
                        name: "file".into(),
                        value: None,
                        path: Some(file.to_string_lossy().into_owned()),
                        file_name: Some("avatar.txt".into()),
                        content_type: Some("text/plain".into()),
                    },
                    MultipartPart {
                        name: "caption".into(),
                        value: Some("hi".into()),
                        path: None,
                        file_name: None,
                        content_type: None,
                    },
                ],
            }),
            timeout_ms: Some(5_000),
            jar: None,
            follow_redirects: Some(false),
            tls: None,
            proxy: None,
        };

        tauri::async_runtime::block_on(http_send(request)).unwrap();
        let raw = String::from_utf8_lossy(&rx.recv_timeout(Duration::from_secs(5)).unwrap()).to_string();

        // The boundary is written by reqwest; a Content-Type we set would be wrong.
        assert!(raw.contains("multipart/form-data; boundary="), "boundary must be generated");
        assert!(raw.contains(r#"name="file""#));
        assert!(raw.contains(r#"filename="avatar.txt""#), "the filename must travel");
        // The file's *contents*, which proves the path was read in Rust rather than
        // the bytes being sent across the IPC bridge.
        assert!(raw.contains("hello from a file"));
        assert!(raw.contains(r#"name="caption""#) && raw.contains("hi"));
        std::fs::remove_file(file).ok();
    }

    #[test]
    fn a_form_body_urlencodes_and_keeps_repeated_keys() {
        let (port, rx) = capture_one_request();
        let request = HttpRequest {
            method: "POST".into(),
            url: format!("http://127.0.0.1:{port}/login"),
            headers: HashMap::new(),
            body: Some(RequestBody::Form {
                fields: vec![
                    ("tag".into(), "a b".into()),
                    ("tag".into(), "c&d".into()),
                ],
            }),
            timeout_ms: Some(5_000),
            jar: None,
            follow_redirects: Some(false),
            tls: None,
            proxy: None,
        };

        tauri::async_runtime::block_on(http_send(request)).unwrap();
        let raw = String::from_utf8_lossy(&rx.recv_timeout(Duration::from_secs(5)).unwrap()).to_string();

        assert!(raw.contains("application/x-www-form-urlencoded"));
        // Repeated keys survive, and the encoding is done for us; hand-rolling
        // this is exactly where a list of values gets silently flattened.
        assert!(raw.contains("tag=a+b&tag=c%26d"), "got: {raw}");
    }

    #[test]
    fn certificate_failures_are_recognised_across_wordings() {
        // rustls reports these through several error types; the hint is the same.
        assert!(is_certificate_failure("invalid peer certificate: UnknownIssuer"));
        assert!(is_certificate_failure("self-signed certificate in chain"));
        assert!(!is_certificate_failure("dns error: failed to lookup address"));
        assert!(!is_certificate_failure("operation timed out"));
    }
}
