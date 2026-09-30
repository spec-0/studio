import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isMac } from "./platform";
import { inTauri } from "./request";

/** The event `src-tauri/src/menu.rs` sends when Settings… is picked from the menu. */
export const OPEN_SETTINGS_EVENT = "studio://open-settings";

/** Settings… was picked from the native menu. Does nothing in the browser preview. */
export async function onSettingsRequested(handler: () => void): Promise<UnlistenFn> {
  if (!inTauri) return () => {};
  return listen(OPEN_SETTINGS_EVENT, handler);
}

/** The event `src-tauri/src/menu.rs` sends when File → Close Tab (⌘W) is picked on macOS. */
export const CLOSE_TAB_EVENT = "studio://close-tab";

/**
 * The macOS menu owns ⌘W, so the key can't close the window while a request
 * tab is open. Elsewhere Ctrl+W is handled in the web view (see `tabShortcutFor`).
 */
export const menuClosesTabs = inTauri && isMac;

/** Close Tab was picked from the native menu. Does nothing outside the macOS app. */
export async function onCloseTabRequested(handler: () => void): Promise<UnlistenFn> {
  if (!menuClosesTabs) return () => {};
  return listen(CLOSE_TAB_EVENT, handler);
}

/**
 * Tell the menu whether a tab is on screen: it then reads "Close Tab" and ⌘W
 * closes the tab; otherwise it reads "Close Window" and ⌘W closes the window,
 * as it always has.
 */
export async function setMenuClosesTab(tabOpen: boolean): Promise<void> {
  if (!menuClosesTabs) return;
  try {
    await invoke("menu_close_tab", { tabOpen });
  } catch {
    // An older shell without the command: ⌘W keeps closing the window.
  }
}
