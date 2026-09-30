//! The native menu.
//!
//! On macOS this is Tauri's standard menu with two additions in the app menu,
//! where Mac apps put them: "Settings…" (⌘,) and "Check for Updates…". Its
//! File menu is Studio's own: ⌘W closes the request tab on screen, and only
//! closes the window when no tab is (the item says which), with ⇧⌘W to close
//! the window either way. The standard Close Window item is left out, since it
//! would take ⌘W back.
//! Windows and Linux get a File menu holding Settings… (Ctrl+,) and Quit, and a
//! Help menu holding Check for Updates… and About. Those two menus are all:
//! a full File/Edit/Window bar would add chrome for actions the window and
//! keyboard already provide.
//!
//! Choosing an item only tells the frontend what was picked. Nothing here
//! contacts the network.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::menu::{Menu, MenuEvent, MenuItem};
use tauri::{AppHandle, Emitter, Manager, Runtime};

pub const CHECK_FOR_UPDATES: &str = "check-for-updates";
/// The event the frontend listens for to open the update dialog.
pub const CHECK_FOR_UPDATES_EVENT: &str = "studio://check-for-updates";

pub const OPEN_SETTINGS: &str = "open-settings";
/// The event the frontend listens for to show the Settings page.
pub const OPEN_SETTINGS_EVENT: &str = "studio://open-settings";
/// ⌘, on macOS and Ctrl+, elsewhere: the usual shortcut for an app's settings.
pub const OPEN_SETTINGS_ACCELERATOR: &str = "CmdOrCtrl+,";

/// ⌘W on macOS: closes the request tab on screen, or the window when there is none.
pub const CLOSE_TAB: &str = "close-tab";
/// The event the frontend listens for to close the request tab on screen.
pub const CLOSE_TAB_EVENT: &str = "studio://close-tab";
pub const CLOSE_TAB_ACCELERATOR: &str = "CmdOrCtrl+W";
/// ⇧⌘W on macOS: closes the window, whether or not a tab is open.
pub const CLOSE_WINDOW: &str = "close-window";
pub const CLOSE_WINDOW_ACCELERATOR: &str = "CmdOrCtrl+Shift+W";
const FILE_MENU: &str = "file-menu";

/// Whether a request tab is on screen, as the frontend last said.
static TAB_OPEN: AtomicBool = AtomicBool::new(false);

/// What ⌘W does.
#[derive(Debug, PartialEq, Eq)]
pub enum CloseAction {
    Tab,
    Window,
}

pub fn close_action(tab_open: bool) -> CloseAction {
    if tab_open {
        CloseAction::Tab
    } else {
        CloseAction::Window
    }
}

/// The label of the ⌘W item.
pub fn close_label(tab_open: bool) -> &'static str {
    match close_action(tab_open) {
        CloseAction::Tab => "Close Tab",
        CloseAction::Window => "Close Window",
    }
}

/// The frontend event for a menu item, or `None` for items the menu handles itself.
pub fn event_for(id: &str) -> Option<&'static str> {
    match id {
        CHECK_FOR_UPDATES => Some(CHECK_FOR_UPDATES_EVENT),
        OPEN_SETTINGS => Some(OPEN_SETTINGS_EVENT),
        _ => None,
    }
}

/// The frontend says whether a request tab is on screen. Only changes the menu on macOS.
#[tauri::command]
pub fn menu_close_tab(app: AppHandle, tab_open: bool) {
    TAB_OPEN.store(tab_open, Ordering::Relaxed);
    let item = app
        .menu()
        .and_then(|menu| menu.get(FILE_MENU))
        .and_then(|file| file.as_submenu().and_then(|file| file.get(CLOSE_TAB)))
        .and_then(|item| item.as_menuitem().cloned());
    if let Some(item) = item {
        let _ = item.set_text(close_label(tab_open));
    }
}

fn close_focused_window<R: Runtime>(app: &AppHandle<R>) {
    let windows = app.webview_windows();
    let focused = windows
        .values()
        .find(|window| window.is_focused().unwrap_or(false))
        .or_else(|| windows.get("main"));
    if let Some(window) = focused {
        let _ = window.close();
    }
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let check = MenuItem::with_id(app, CHECK_FOR_UPDATES, "Check for Updates…", true, None::<&str>)?;
    let settings = MenuItem::with_id(
        app,
        OPEN_SETTINGS,
        "Settings…",
        true,
        Some(OPEN_SETTINGS_ACCELERATOR),
    )?;

    #[cfg(target_os = "macos")]
    {
        use tauri::menu::{PredefinedMenuItem, Submenu};
        let menu = Menu::default(app)?;
        // The first submenu is the app menu. After About: a separator,
        // Settings…, Check for Updates…, then the rest of the default items.
        if let Some(app_menu) = menu.items()?.first().and_then(|item| item.as_submenu().cloned()) {
            app_menu.insert(&check, 1)?;
            app_menu.insert(&settings, 1)?;
            app_menu.insert(&PredefinedMenuItem::separator(app)?, 1)?;
        }
        // The default File menu holds only Close Window (⌘W), and the Window
        // menu repeats it. Both go, so ⌘W reaches Close Tab below.
        let items = menu.items()?;
        if let Some(file) = items.get(1).and_then(|item| item.as_submenu().cloned()) {
            if file.text()? == "File" {
                menu.remove(&file)?;
            }
        }
        for item in menu.items()? {
            if let Some(submenu) = item.as_submenu() {
                if submenu.text()? == "Window" {
                    for entry in submenu.items()? {
                        if let Some(predefined) = entry.as_predefined_menuitem() {
                            if predefined.text()? == "Close Window" {
                                submenu.remove(predefined)?;
                            }
                        }
                    }
                }
            }
        }
        let close_tab = MenuItem::with_id(
            app,
            CLOSE_TAB,
            close_label(TAB_OPEN.load(Ordering::Relaxed)),
            true,
            Some(CLOSE_TAB_ACCELERATOR),
        )?;
        let close_window =
            MenuItem::with_id(app, CLOSE_WINDOW, "Close Window", true, Some(CLOSE_WINDOW_ACCELERATOR))?;
        let file = Submenu::with_id_and_items(app, FILE_MENU, "File", true, &[&close_tab, &close_window])?;
        menu.insert(&file, 1)?;
        Ok(menu)
    }

    #[cfg(not(target_os = "macos"))]
    {
        use tauri::menu::{AboutMetadata, PredefinedMenuItem, Submenu};
        let about = AboutMetadata {
            name: Some(app.package_info().name.clone()),
            version: Some(app.package_info().version.to_string()),
            ..Default::default()
        };
        let file = Submenu::with_items(
            app,
            "File",
            true,
            &[
                &settings,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::quit(app, None)?,
            ],
        )?;
        let help = Submenu::with_items(
            app,
            "Help",
            true,
            &[
                &check,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::about(app, None, Some(about))?,
            ],
        )?;
        Menu::with_items(app, &[&file, &help])
    }
}

pub fn on_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let id = event.id().as_ref();
    if id == CLOSE_TAB {
        match close_action(TAB_OPEN.load(Ordering::Relaxed)) {
            CloseAction::Tab => {
                let _ = app.emit(CLOSE_TAB_EVENT, ());
            }
            CloseAction::Window => close_focused_window(app),
        }
    } else if id == CLOSE_WINDOW {
        close_focused_window(app);
    } else if let Some(name) = event_for(id) {
        let _ = app.emit(name, ());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn menu_items_map_to_their_frontend_events() {
        assert_eq!(event_for(CHECK_FOR_UPDATES), Some("studio://check-for-updates"));
        assert_eq!(event_for(OPEN_SETTINGS), Some("studio://open-settings"));
        assert_eq!(event_for("quit"), None);
    }

    #[test]
    fn settings_uses_the_platform_shortcut() {
        assert_eq!(OPEN_SETTINGS_ACCELERATOR, "CmdOrCtrl+,");
    }

    #[test]
    fn command_w_closes_the_tab_while_one_is_open_and_the_window_otherwise() {
        assert_eq!(close_action(true), CloseAction::Tab);
        assert_eq!(close_label(true), "Close Tab");
        assert_eq!(close_action(false), CloseAction::Window);
        assert_eq!(close_label(false), "Close Window");
        assert_eq!(CLOSE_TAB_ACCELERATOR, "CmdOrCtrl+W");
        assert_eq!(CLOSE_WINDOW_ACCELERATOR, "CmdOrCtrl+Shift+W");
        // Closing is handled by the menu itself, not passed on as a plain event.
        assert_eq!(event_for(CLOSE_TAB), None);
        assert_eq!(event_for(CLOSE_WINDOW), None);
    }
}
