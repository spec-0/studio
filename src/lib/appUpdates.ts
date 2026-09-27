import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { transportFor, type ConnectionSettings } from "./connection";
import { inTauri } from "./request";
import { readStore, writeStore, STORE } from "./store";

/**
 * Updates to Studio itself — not to be confused with a spec having a newer
 * version upstream, which lives in `spec0.ts`.
 *
 * Studio makes no request you didn't ask for. A check runs only when someone
 * picks "Check for Updates…" from the menu, or has turned on
 * `checkOnStart`, which is off unless they turn it on. The Rust side
 * (`src-tauri/src/updates.rs`) never starts one by itself.
 */

/** The one address a check contacts. Shown to the user, so keep it honest. */
export const UPDATE_ENDPOINT =
  "https://github.com/spec-0/studio/releases/latest/download/latest.json";
export const RELEASES_PAGE = "https://github.com/spec-0/studio/releases/latest";

export interface UpdatePrefs {
  /** Check once each time Studio starts. Off by default, and must stay so. */
  checkOnStart: boolean;
}

export const DEFAULT_UPDATE_PREFS: UpdatePrefs = { checkOnStart: false };

export async function loadUpdatePrefs(): Promise<UpdatePrefs> {
  const stored = await readStore<Partial<UpdatePrefs>>(STORE.updates, {});
  // Only an explicit `true` turns it on — a missing or damaged file means off.
  return { checkOnStart: stored.checkOnStart === true };
}

export async function saveUpdatePrefs(prefs: UpdatePrefs): Promise<void> {
  await writeStore(STORE.updates, prefs);
}

/** A newer version, as described by the release's `latest.json`. */
export interface AvailableUpdate {
  version: string;
  currentVersion: string;
  notes?: string | null;
  date?: string | null;
}

/**
 * The proxy for the check: the same one Studio's own requests would use to
 * reach GitHub. `undefined` leaves the environment's proxy settings in charge.
 */
export function updateProxy(settings: ConnectionSettings) {
  return transportFor(settings, UPDATE_ENDPOINT).proxy;
}

export async function currentVersion(): Promise<string | null> {
  if (!inTauri) return null;
  try {
    return await invoke<string>("update_current_version");
  } catch {
    return null;
  }
}

/** Ask GitHub for the latest release. `null` means this is the latest. */
export async function checkForUpdate(
  settings: ConnectionSettings,
): Promise<AvailableUpdate | null> {
  if (!inTauri) throw new Error("Updates need the desktop app.");
  return invoke<AvailableUpdate | null>("update_check", { proxy: updateProxy(settings) });
}

/** Download and install what the last check found, then relaunch. */
export async function installUpdate(): Promise<void> {
  await invoke("update_install");
}

/** The menu item was picked. */
export async function onCheckRequested(handler: () => void): Promise<UnlistenFn> {
  if (!inTauri) return () => {};
  return listen("studio://check-for-updates", handler);
}

export interface UpdateProgress {
  downloaded: number;
  total?: number | null;
}

export async function onUpdateProgress(
  handler: (progress: UpdateProgress) => void,
): Promise<UnlistenFn> {
  if (!inTauri) return () => {};
  return listen<UpdateProgress>("studio://update-progress", (event) => handler(event.payload));
}

/** "40%" when the size is known, "3.2 MB" when it isn't. */
export function describeProgress(progress: UpdateProgress | null): string {
  if (!progress) return "";
  if (progress.total && progress.total > 0) {
    return `${Math.min(100, Math.round((progress.downloaded / progress.total) * 100))}%`;
  }
  return `${(progress.downloaded / 1_000_000).toFixed(1)} MB`;
}
