//! Loopback listener for the Spec0 browser sign-in.
//!
//! Mirrors the flow the Spec0 CLI already uses: bind `127.0.0.1:<port>`, open
//! `{appUrl}/cli-auth?state=…&redirect_uri=http://127.0.0.1:<port>/callback`,
//! and wait for the browser to come back with `token`, `org`, `org_name`.
//!
//! This has to live in Rust, because a webview cannot listen on a socket.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

/// The top of every page shown in the browser after sign-in: the Spec0 mark, centred.
macro_rules! page {
    ($title:literal, $sub:literal) => {
        concat!(
            "<!doctype html><meta charset=utf-8><title>Spec0 Studio</title>",
            "<link rel=icon href=\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='-6 -5 40 40'%3E%3Crect x='-6' y='-5' width='40' height='40' rx='9' fill='%235B4CF5'/%3E%3Cpath fill='%23fff' d='M14 24C9.75758 24 7 24 7 15C7 6 9.75758 6 14 6C18.2424 6 21 6 21 15C21 24 18.2424 24 14 24ZM9.87879 18.024L17.2424 9.12C16.5758 8.256 15.7576 8.16 14 8.16C11.2727 8.16 9.72727 8.16 9.72727 15C9.72727 16.224 9.78788 17.208 9.87879 18.024ZM14 21.84C16.7273 21.84 18.2727 21.84 18.2727 15C18.2727 13.776 18.2121 12.816 18.1212 12L10.7576 20.88C11.4242 21.744 12.303 21.84 14 21.84Z'/%3E%3Cpath fill='%23fff' d='M3.82593 30C1.71293 30 0 28.0102 0 25.5556V4.44444C0 1.98985 1.71293 0 3.82593 0H10.4845C11.0331 0 10.9995 0.47386 10.9995 1.11111C10.9995 1.74836 11.0486 2 10.5 2H5C2.887 2 1.91296 3.10096 1.91296 5.55556V24.4444C1.91296 26.9124 2.87556 28.019 5 28H10.4883C11.0377 27.9951 10.9995 28.2506 10.9995 28.8889C10.9995 29.5237 11.0348 30 10.4883 30H3.82593Z'/%3E%3Cpath fill='%23fff' d='M24.1741 30C26.2871 30 28 28.0102 28 25.5556V4.44444C28 1.98985 26.2871 0 24.1741 0H17.5155C16.9669 0 17.0005 0.47386 17.0005 1.11111C17.0005 1.74836 16.9514 2 17.5 2H23C25.113 2 26.087 3.10096 26.087 5.55556V24.4444C26.087 26.9124 25.1244 28.019 23 28H17.5117C16.9623 27.9951 17.0005 28.2506 17.0005 28.8889C17.0005 29.5237 16.9652 30 17.5117 30H24.1741Z'/%3E%3C/svg%3E\">",
            "<body style=\"font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#0E0E0C;color:#F4F2EC\">",
            "<div style=\"text-align:center\">",
            "<svg width=\"40\" height=\"43\" viewBox=\"0 0 28 30\" fill=\"#5B4CF5\" aria-label=\"Spec0\" role=\"img\" style=\"margin-bottom:20px\"><path d=\"M14 24C9.75758 24 7 24 7 15C7 6 9.75758 6 14 6C18.2424 6 21 6 21 15C21 24 18.2424 24 14 24ZM9.87879 18.024L17.2424 9.12C16.5758 8.256 15.7576 8.16 14 8.16C11.2727 8.16 9.72727 8.16 9.72727 15C9.72727 16.224 9.78788 17.208 9.87879 18.024ZM14 21.84C16.7273 21.84 18.2727 21.84 18.2727 15C18.2727 13.776 18.2121 12.816 18.1212 12L10.7576 20.88C11.4242 21.744 12.303 21.84 14 21.84Z\"/><path d=\"M3.82593 30C1.71293 30 0 28.0102 0 25.5556V4.44444C0 1.98985 1.71293 0 3.82593 0H10.4845C11.0331 0 10.9995 0.47386 10.9995 1.11111C10.9995 1.74836 11.0486 2 10.5 2H5C2.887 2 1.91296 3.10096 1.91296 5.55556V24.4444C1.91296 26.9124 2.87556 28.019 5 28H10.4883C11.0377 27.9951 10.9995 28.2506 10.9995 28.8889C10.9995 29.5237 11.0348 30 10.4883 30H3.82593Z\"/><path d=\"M24.1741 30C26.2871 30 28 28.0102 28 25.5556V4.44444C28 1.98985 26.2871 0 24.1741 0H17.5155C16.9669 0 17.0005 0.47386 17.0005 1.11111C17.0005 1.74836 16.9514 2 17.5 2H23C25.113 2 26.087 3.10096 26.087 5.55556V24.4444C26.087 26.9124 25.1244 28.019 23 28H17.5117C16.9623 27.9951 17.0005 28.2506 17.0005 28.8889C17.0005 29.5237 16.9652 30 17.5117 30H24.1741Z\"/></svg>",
            "<p style=\"font-size:15px\">", $title, "</p>",
            "<p style=\"font-size:13px;opacity:.6\">", $sub, "</p></div>"
        )
    };
}

const PAGE_OK: &str = page!("Signed in to Spec0.", "You can close this tab and return to Spec0 Studio.");

const PAGE_BAD: &str = page!("Sign-in didn't complete.", "No token was returned. Try again from Spec0 Studio.");

const PAGE_CANCELLED: &str = page!("Sign-in cancelled.", "Nothing was changed. You can close this tab.");

const PAGE_MISMATCH: &str = page!(
    "This sign-in wasn't started by Spec0 Studio.",
    "Nothing was saved. Start again from Spec0 Studio."
);

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
