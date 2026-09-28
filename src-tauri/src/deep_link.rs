//! `spec0://` links, for example from an "Open in Studio" button on a web page.
//!
//! Rust only receives links and hands them to the web view; it never acts on
//! one. Deciding whether a link is acceptable, asking the user, and fetching
//! the spec after they agree all happen in `src/lib/deepLink.ts`, where the
//! rules are tested. A web page can trigger a link without the user expecting
//! Studio to do anything, so nothing here makes a request.
//!
//! Links wait in a small queue until the web view takes them with
//! `deep_link_take`. That covers a link that launched Studio, which arrives
//! before the interface is listening, and a link that arrives while it runs
//! (announced with the `studio://deep-link` event).
//!
//! How the scheme reaches the OS differs per platform:
//!
//! - **macOS**: the bundle's `Info.plist`, written by the bundler from
//!   `plugins.deep-link` in `tauri.conf.json`. Only the installed app is
//!   registered; `tauri dev` is not. The OS delivers a link to the running app.
//! - **Windows**: the installer writes the registry keys. A development build
//!   registers itself at start. A link starts a second process, which
//!   `tauri-plugin-single-instance` turns into a message to the running one.
//! - **Linux**: the `.deb` gets it from its `.desktop` entry. An AppImage has no
//!   installer, so it registers itself at start (again after being moved). A
//!   second process is forwarded as on Windows.

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_deep_link::DeepLinkExt;

/// Emitted when a link is queued. Carries nothing; the web view takes the queue.
pub const EVENT: &str = "studio://deep-link";

/// Links kept while nobody takes them. A page firing links in a loop can't grow this.
const MAX_QUEUED: usize = 4;

/// Longer than any real link. The web view applies its own, tighter limits.
const MAX_LEN: usize = 8 * 1024;

#[derive(Default)]
pub struct Queue(Mutex<Vec<String>>);

/// Add `url` to `queue` if it's a `spec0:` link worth passing on. Returns whether it was added.
fn enqueue(queue: &mut Vec<String>, url: &str) -> bool {
    let is_ours = url
        .get(..6)
        .is_some_and(|scheme| scheme.eq_ignore_ascii_case("spec0:"));
    if !is_ours || url.len() > MAX_LEN {
        return false;
    }
    // The same link twice in a row (a double click, or macOS delivering the link
    // that started the app through both routes) should ask once.
    if queue.last().is_some_and(|last| last == url) {
        return false;
    }
    queue.push(url.to_string());
    if queue.len() > MAX_QUEUED {
        let excess = queue.len() - MAX_QUEUED;
        queue.drain(..excess);
    }
    true
}

fn receive<R: Runtime>(app: &AppHandle<R>, urls: Vec<String>) {
    let queue = app.state::<Queue>();
    let added = {
        let mut queue = queue.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        urls.iter().fold(false, |added, url| enqueue(&mut queue, url) || added)
    };
    if added {
        focus(app);
        let _ = app.emit(EVENT, ());
    }
}

/// Bring the main window to the front, restoring it if it was minimised.
pub fn focus<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Register at runtime where the platform needs it, then start listening.
pub fn setup<R: Runtime>(app: &AppHandle<R>) {
    app.manage(Queue::default());

    // Windows installs register through the installer, so only a development
    // build needs this. An AppImage is never installed, and a moved one points
    // at its old path, so it registers every time it starts.
    #[cfg(any(windows, target_os = "linux"))]
    {
        #[cfg(windows)]
        let needed = cfg!(debug_assertions);
        #[cfg(target_os = "linux")]
        let needed = cfg!(debug_assertions) || app.env().appimage.is_some();
        if needed {
            if let Err(error) = app.deep_link().register_all() {
                eprintln!("couldn't register the spec0:// scheme: {error}");
            }
        }
    }

    // A link that started the app (read from the command line on Windows and
    // Linux; on macOS it arrives through `on_open_url` just after start).
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        receive(app, urls.iter().map(|url| url.to_string()).collect());
    }

    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        receive(&handle, event.urls().iter().map(|url| url.to_string()).collect());
    });
}

/// Hand the queued links to the web view and forget them.
#[tauri::command]
pub fn deep_link_take(queue: State<'_, Queue>) -> Vec<String> {
    let mut queue = queue.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    std::mem::take(&mut *queue)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_spec0_links_are_queued() {
        let mut queue = Vec::new();
        assert!(enqueue(&mut queue, "spec0://open?spec=x"));
        assert!(enqueue(&mut queue, "SPEC0://open?spec=y"));
        assert!(!enqueue(&mut queue, "https://example.com"));
        assert!(!enqueue(&mut queue, "spec"));
        assert!(!enqueue(&mut queue, "--some-flag"));
        assert_eq!(queue.len(), 2);
    }

    #[test]
    fn a_repeated_link_is_queued_once() {
        let mut queue = Vec::new();
        assert!(enqueue(&mut queue, "spec0://open?spec=x"));
        assert!(!enqueue(&mut queue, "spec0://open?spec=x"));
        assert_eq!(queue, vec!["spec0://open?spec=x"]);
    }

    #[test]
    fn the_queue_keeps_only_the_newest_links() {
        let mut queue = Vec::new();
        for index in 0..10 {
            enqueue(&mut queue, &format!("spec0://open?n={index}"));
        }
        assert_eq!(queue.len(), MAX_QUEUED);
        assert_eq!(queue.last().unwrap(), "spec0://open?n=9");
        assert_eq!(queue.first().unwrap(), "spec0://open?n=6");
    }

    #[test]
    fn overlong_links_are_dropped() {
        let mut queue = Vec::new();
        let long = format!("spec0://open?spec={}", "a".repeat(MAX_LEN));
        assert!(!enqueue(&mut queue, &long));
        assert!(queue.is_empty());
    }
}
