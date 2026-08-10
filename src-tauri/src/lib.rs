mod cookies;
mod git;
mod http;
mod oauth;
mod storage;

/// spec0 Studio — Tauri shell.
///
/// The shell is Rust for two structural reasons, not for the binary size:
///
///  - **HTTP** goes out through `reqwest` in `http`, with exactly the headers the
///    caller asked for and **no `Origin`**. A desktop client isn't a browser and
///    has no origin; sending one makes every CORS-configured server reject it.
///  - **Sign-in** needs a loopback socket, which a webview cannot hold.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            http::http_send,
            http::cookies_list,
            http::cookies_clear,
            http::save_response,
            git::git_info,
            oauth::oauth_listen,
            storage::read_text,
            storage::store_read,
            storage::store_write,
            storage::store_location,
            storage::cli_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running spec0 Studio");
}
