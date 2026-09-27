//! The native menu.
//!
//! On macOS this is Tauri's standard menu with two additions in the app menu,
//! where Mac apps put them: "Settings…" (⌘,) and "Check for Updates…".
//! Windows and Linux get a File menu holding Settings… (Ctrl+,) and Quit, and a
//! Help menu holding Check for Updates… and About. Those two menus are all:
//! a full File/Edit/Window bar would add chrome for actions the window and
//! keyboard already provide.
//!
//! Choosing an item only tells the frontend what was picked. Nothing here
//! contacts the network.

use tauri::menu::{Menu, MenuEvent, MenuItem};
use tauri::{AppHandle, Emitter, Runtime};

pub const CHECK_FOR_UPDATES: &str = "check-for-updates";
/// The event the frontend listens for to open the update dialog.
pub const CHECK_FOR_UPDATES_EVENT: &str = "studio://check-for-updates";

pub const OPEN_SETTINGS: &str = "open-settings";
/// The event the frontend listens for to show the Settings page.
pub const OPEN_SETTINGS_EVENT: &str = "studio://open-settings";
/// ⌘, on macOS and Ctrl+, elsewhere: the usual shortcut for an app's settings.
pub const OPEN_SETTINGS_ACCELERATOR: &str = "CmdOrCtrl+,";

/// The frontend event for a menu item, or `None` for items the menu handles itself.
pub fn event_for(id: &str) -> Option<&'static str> {
    match id {
        CHECK_FOR_UPDATES => Some(CHECK_FOR_UPDATES_EVENT),
        OPEN_SETTINGS => Some(OPEN_SETTINGS_EVENT),
        _ => None,
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
        use tauri::menu::PredefinedMenuItem;
        let menu = Menu::default(app)?;
        // The first submenu is the app menu. After About: a separator,
        // Settings…, Check for Updates…, then the rest of the default items.
        if let Some(app_menu) = menu.items()?.first().and_then(|item| item.as_submenu().cloned()) {
            app_menu.insert(&check, 1)?;
            app_menu.insert(&settings, 1)?;
            app_menu.insert(&PredefinedMenuItem::separator(app)?, 1)?;
        }
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
    if let Some(name) = event_for(event.id().as_ref()) {
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
}
