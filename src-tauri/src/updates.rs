//! Checking for, and installing, a new version of Studio.
//!
//! Studio makes no request you didn't ask for, and that includes this one. A
//! check happens only when someone picks "Check for Updates…" from the menu, or
//! has turned on "Check for updates when Studio starts" (off by default). The
//! frontend owns that decision; this module never starts a check on its own.
//!
//! What a check contacts: one GET for `latest.json` on GitHub's release download
//! URL (see `plugins.updater.endpoints` in `tauri.conf.json`). Installing then
//! downloads the package that file names, from the same release. Every package
//! is signed, and the updater refuses one whose signature doesn't match the
//! public key built into this copy of the app.
//!
//! The check is done here rather than through the plugin's JavaScript API so it
//! can use the proxy from Studio's own connection settings, the same way
//! requests in `http.rs` do.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use url::Url;

/// The value `tauri.conf.json` ships with until a maintainer pastes the real
/// public key in. The release workflow refuses to publish while it is present;
/// a local or test build that still carries it simply can't update.
pub const PUBKEY_PLACEHOLDER: &str = "REPLACE_WITH_UPDATER_PUBLIC_KEY";

/// Hosts a check or a download can reach. `github.com` serves `latest.json`
/// and redirects release files to GitHub's download hosts.
const UPDATE_HOSTS: [&str; 3] = [
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
];

/// The update found by the last check, held until the user says install.
#[derive(Default)]
pub struct Pending(Mutex<Option<Update>>);

/// Same shape the frontend already sends to `http_send`.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProxyArg {
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    no_proxy: Option<String>,
    #[serde(default)]
    disabled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    current_version: String,
    notes: Option<String>,
    date: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

/// Whether this build carries a real update key.
fn has_update_key(app: &AppHandle) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("pubkey"))
        .and_then(|key| key.as_str())
        .map(|key| !key.trim().is_empty() && key.trim() != PUBKEY_PLACEHOLDER)
        .unwrap_or(false)
}

/// True when an entry in a `NO_PROXY`-style list covers `host`.
fn bypasses(list: &str, host: &str) -> bool {
    list.split(',')
        .map(|entry| entry.trim().to_ascii_lowercase())
        .filter(|entry| !entry.is_empty())
        .any(|entry| {
            if entry == "*" {
                return true;
            }
            let bare = entry.trim_start_matches("*.").trim_start_matches('.');
            host == bare || host.ends_with(&format!(".{bare}"))
        })
}

/// Studio's current version, so the dialog can say "you have X".
#[tauri::command]
pub fn update_current_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Ask GitHub whether there is a newer version. `Ok(None)` means up to date.
#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    pending: State<'_, Pending>,
    proxy: Option<ProxyArg>,
) -> Result<Option<UpdateInfo>, String> {
    if !has_update_key(&app) {
        return Err("This copy of Studio was built without an update key, so it can't \
                    check for updates. New versions are on the GitHub releases page."
            .into());
    }

    let mut builder = app.updater_builder().timeout(Duration::from_secs(30));
    let proxy = proxy.unwrap_or_default();
    if proxy.disabled {
        builder = builder.no_proxy();
    } else if let Some(url) = proxy.url.as_deref().filter(|u| !u.trim().is_empty()) {
        let skip = proxy
            .no_proxy
            .as_deref()
            .map(|list| UPDATE_HOSTS.iter().all(|host| bypasses(list, host)))
            .unwrap_or(false);
        if !skip {
            let url = Url::parse(url.trim())
                .map_err(|error| format!("that proxy URL isn't usable: {error}"))?;
            builder = builder.proxy(url);
        }
    }
    // Otherwise the environment's HTTPS_PROXY / NO_PROXY and the system proxy
    // apply, as they do for every other request Studio sends.

    let updater = builder.build().map_err(|error| error.to_string())?;
    let found = updater.check().await.map_err(|error| error.to_string())?;

    let info = found.as_ref().map(|update| UpdateInfo {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update.body.clone(),
        date: update.date.map(|date| date.to_string()),
    });
    *pending.0.lock().map_err(|error| error.to_string())? = found;
    Ok(info)
}

/// Download and install the update found by the last check, then relaunch.
///
/// On Windows the installer takes over and closes Studio itself. Progress goes
/// out as `studio://update-progress` events.
#[tauri::command]
pub async fn update_install(app: AppHandle, pending: State<'_, Pending>) -> Result<(), String> {
    let update = pending
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .take()
        .ok_or("No update to install. Check for updates first.")?;

    let mut downloaded: u64 = 0;
    let events = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = events.emit("studio://update-progress", Progress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(|error| error.to_string())?;

    app.restart();
}

/// Register the managed state the commands above rely on.
pub fn manage(app: &AppHandle) {
    app.manage(Pending::default());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_no_proxy_list_matches_hosts_and_their_subdomains() {
        assert!(bypasses("github.com", "github.com"));
        assert!(bypasses("localhost, .githubusercontent.com", "objects.githubusercontent.com"));
        assert!(bypasses("*.githubusercontent.com", "release-assets.githubusercontent.com"));
        assert!(bypasses("*", "github.com"));
        assert!(!bypasses("hub.com", "github.com"));
        assert!(!bypasses("internal.corp", "github.com"));
        assert!(!bypasses("", "github.com"));
    }

    #[test]
    fn the_shipped_config_names_only_the_github_endpoint() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let updater = &config["plugins"]["updater"];
        assert_eq!(
            updater["endpoints"],
            serde_json::json!(["https://github.com/spec-0/studio/releases/latest/download/latest.json"])
        );
    }
}
