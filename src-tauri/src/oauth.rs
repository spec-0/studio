//! Loopback listener for the spec0 browser sign-in.
//!
//! Mirrors the flow the spec0 CLI already uses: bind `127.0.0.1:<port>`, open
//! `{appUrl}/cli-auth?state=…&redirect_uri=http://127.0.0.1:<port>/callback`,
//! and wait for the browser to come back with `token`, `org`, `org_name`.
//!
//! This has to live in Rust, because a webview cannot listen on a socket.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

const PAGE_OK: &str = "<!doctype html><meta charset=utf-8><title>spec0 Studio</title>\
<body style=\"font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#0E0E0C;color:#F4F2EC\">\
<div style=\"text-align:center\"><p style=\"font-size:15px\">Signed in to spec0.</p>\
<p style=\"font-size:13px;opacity:.6\">You can close this tab and return to spec0 Studio.</p></div>";

const PAGE_BAD: &str = "<!doctype html><meta charset=utf-8><title>spec0 Studio</title>\
<body style=\"font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#0E0E0C;color:#F4F2EC\">\
<div style=\"text-align:center\"><p style=\"font-size:15px\">Sign-in didn't complete.</p>\
<p style=\"font-size:13px;opacity:.6\">No token was returned. Try again from spec0 Studio.</p></div>";

const PAGE_CANCELLED: &str = "<!doctype html><meta charset=utf-8><title>spec0 Studio</title>\
<body style=\"font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#0E0E0C;color:#F4F2EC\">\
<div style=\"text-align:center\"><p style=\"font-size:15px\">Sign-in cancelled.</p>\
<p style=\"font-size:13px;opacity:.6\">Nothing was changed. You can close this tab.</p></div>";

const PAGE_MISMATCH: &str = "<!doctype html><meta charset=utf-8><title>spec0 Studio</title>\
<body style=\"font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#0E0E0C;color:#F4F2EC\">\
<div style=\"text-align:center\"><p style=\"font-size:15px\">This sign-in wasn't started by spec0 Studio.</p>\
<p style=\"font-size:13px;opacity:.6\">Nothing was saved. Start again from spec0 Studio.</p></div>";

/// Wait for one redirect on `127.0.0.1:<port>/callback` and return its query parameters.
///
/// `expected_state` only picks the page shown in the browser tab. The web view
/// checks `state` again before it keeps anything.
#[tauri::command]
pub async fn oauth_listen(
    port: u16,
    timeout_secs: u64,
    expected_state: Option<String>,
) -> Result<HashMap<String, String>, String> {
    tauri::async_runtime::spawn_blocking(move || listen(port, timeout_secs, expected_state))
        .await
        .map_err(|error| error.to_string())?
}

/// The page to show for a callback.
///
/// A returned `state` that differs from the one sent is refused. A missing one
/// is accepted, because older sign-in pages don't send it back yet.
fn page_for(params: &HashMap<String, String>, expected_state: Option<&str>) -> &'static str {
    if let (Some(expected), Some(got)) = (expected_state, params.get("state")) {
        if got != expected {
            return PAGE_MISMATCH;
        }
    }
    if params.get("error").map(String::as_str) == Some("access_denied") {
        return PAGE_CANCELLED;
    }
    if params.contains_key("token") {
        PAGE_OK
    } else {
        PAGE_BAD
    }
}

fn listen(
    port: u16,
    timeout_secs: u64,
    expected_state: Option<String>,
) -> Result<HashMap<String, String>, String> {
    let listener = TcpListener::bind(("127.0.0.1", port))
        .map_err(|error| format!("could not listen on 127.0.0.1:{port}: {error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;

    let deadline = Instant::now() + Duration::from_secs(timeout_secs);
    loop {
        match listener.accept() {
            Ok((stream, _)) => return handle(stream, expected_state.as_deref()),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err("timed out waiting for the browser to come back".into());
                }
                std::thread::sleep(Duration::from_millis(120));
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}

fn handle(
    mut stream: TcpStream,
    expected_state: Option<&str>,
) -> Result<HashMap<String, String>, String> {
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok();

    let peek = stream.try_clone().map_err(|error| error.to_string())?;
    let mut request_line = String::new();
    BufReader::new(peek)
        .read_line(&mut request_line)
        .map_err(|error| error.to_string())?;

    // "GET /callback?token=…&org=… HTTP/1.1"
    let target = request_line.split_whitespace().nth(1).unwrap_or("");
    let query = target.split_once('?').map(|(_, q)| q).unwrap_or("");
    let params = parse_query(query);

    let body = page_for(&params, expected_state);
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    stream.write_all(response.as_bytes()).ok();
    stream.flush().ok();

    Ok(params)
}

fn parse_query(query: &str) -> HashMap<String, String> {
    query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .filter_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            Some((percent_decode(key), percent_decode(value)))
        })
        .collect()
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(byte) => {
                        out.push(byte);
                        index += 3;
                    }
                    Err(_) => {
                        out.push(bytes[index]);
                        index += 1;
                    }
                }
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn a_matching_state_with_a_token_signs_in() {
        let p = params(&[("token", "t"), ("org", "o"), ("state", "abc")]);
        assert_eq!(page_for(&p, Some("abc")), PAGE_OK);
    }

    #[test]
    fn a_different_state_is_refused_even_with_a_token() {
        let p = params(&[("token", "t"), ("org", "o"), ("state", "other")]);
        assert_eq!(page_for(&p, Some("abc")), PAGE_MISMATCH);
    }

    #[test]
    fn a_missing_state_is_accepted_for_older_sign_in_pages() {
        let p = params(&[("token", "t"), ("org", "o")]);
        assert_eq!(page_for(&p, Some("abc")), PAGE_OK);
    }

    #[test]
    fn cancel_shows_the_cancelled_page() {
        let p = params(&[("error", "access_denied"), ("state", "abc")]);
        assert_eq!(page_for(&p, Some("abc")), PAGE_CANCELLED);
    }

    #[test]
    fn no_token_and_no_error_is_a_failed_sign_in() {
        assert_eq!(page_for(&params(&[]), None), PAGE_BAD);
    }

    #[test]
    fn query_values_are_percent_decoded() {
        let p = parse_query("org_name=Acme%20Ltd&state=a%2Bb");
        assert_eq!(p.get("org_name").map(String::as_str), Some("Acme Ltd"));
        assert_eq!(p.get("state").map(String::as_str), Some("a+b"));
    }
}
