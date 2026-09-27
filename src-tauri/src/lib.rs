mod cookies;
mod git;
mod http;
mod mcp;
mod menu;
mod oauth;
mod secrets;
mod storage;
mod updates;

/// spec0 Studio — Tauri shell.
///
/// The shell is Rust for two structural reasons, not for the binary size:
///
///  - **HTTP** goes out through `reqwest` in `http`, with exactly the headers the
///    caller asked for and **no `Origin`**. A desktop client isn't a browser and
///    has no origin; sending one makes every CORS-configured server reject it.
///  - **Sign-in** needs a loopback socket, which a webview cannot hold.
///  - **Secrets** go to the OS credential store, which only native code can reach.
///  - **The local MCP server** (off unless the user starts it) needs a socket too.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .menu(menu::build)
        .on_menu_event(menu::on_event)
        .setup(|app| {
            updates::manage(app.handle());
            Ok(())
        })
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
            storage::store_delete,
            storage::store_location,
            storage::cli_config,
            updates::update_current_version,
            updates::update_check,
            updates::update_install,
            secrets::secret_backend,
            secrets::secret_get,
            secrets::secret_set,
            secrets::secret_delete,
            secrets::secret_list,
            mcp::mcp_start,
            mcp::mcp_stop,
            mcp::mcp_status,
            mcp::mcp_respond,
        ])
        .run(tauri::generate_context!())
        .expect("error while running spec0 Studio");
}
