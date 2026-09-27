//! The native menu.
//!
//! On macOS this is Tauri's standard menu with one addition: "Check for
//! Updates…" and "Local MCP Server…" in the app menu, where Mac apps put them. Windows and Linux get a
//! single Help menu holding the same item and About — those platforms show no
//! menu bar by default, and a full File/Edit/Window bar would add chrome for
//! actions the window and keyboard already provide.
//!
//! Choosing the item only tells the frontend to run a check. Nothing here
//! contacts the network.

use tauri::menu::{Menu, MenuEvent, MenuItem};
use tauri::{AppHandle, Emitter, Runtime};

pub const CHECK_FOR_UPDATES: &str = "check-for-updates";
/// The event the frontend listens for to open the update dialog.
pub const CHECK_FOR_UPDATES_EVENT: &str = "studio://check-for-updates";
pub const LOCAL_MCP: &str = "local-mcp-server";
/// Opens the local MCP server panel. Opening it starts nothing.
pub const LOCAL_MCP_EVENT: &str = "studio://open-mcp";

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let check = MenuItem::with_id(app, CHECK_FOR_UPDATES, "Check for Updates…", true, None::<&str>)?;
    let mcp = MenuItem::with_id(app, LOCAL_MCP, "Local MCP Server…", true, None::<&str>)?;

    #[cfg(target_os = "macos")]
    {
        use tauri::menu::PredefinedMenuItem;
        let menu = Menu::default(app)?;
        // The first submenu is the app menu: About, then ours, then the rest.
        if let Some(app_menu) = menu.items()?.first().and_then(|item| item.as_submenu().cloned()) {
            app_menu.insert(&mcp, 1)?;
            app_menu.insert(&check, 1)?;
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
        let help = Submenu::with_items(
            app,
            "Help",
            true,
            &[
                &check,
                &mcp,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::about(app, None, Some(about))?,
            ],
        )?;
        Menu::with_items(app, &[&help])
    }
}

pub fn on_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    if event.id() == CHECK_FOR_UPDATES {
        let _ = app.emit(CHECK_FOR_UPDATES_EVENT, ());
    } else if event.id() == LOCAL_MCP {
        let _ = app.emit(LOCAL_MCP_EVENT, ());
    }
}
