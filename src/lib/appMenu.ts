import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { inTauri } from "./request";

/** The event `src-tauri/src/menu.rs` sends when Settings… is picked from the menu. */
export const OPEN_SETTINGS_EVENT = "studio://open-settings";

/** Settings… was picked from the native menu. Does nothing in the browser preview. */
export async function onSettingsRequested(handler: () => void): Promise<UnlistenFn> {
  if (!inTauri) return () => {};
  return listen(OPEN_SETTINGS_EVENT, handler);
}
