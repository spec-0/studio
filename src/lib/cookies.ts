import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "./request";

/**
 * The cookies an API is holding.
 *
 * Jars live in Rust for the lifetime of the process. A session is not written
 * to disk, because persisting one silently across restarts is a credential
 * decision nobody made. This module exists so a session isn't an invisible
 * variable: you can see what's held and throw it away.
 */

export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: string | null;
  secure: boolean;
  httpOnly: boolean;
}

export async function listCookies(jar: string): Promise<StoredCookie[]> {
  if (!inTauri) return [];
  try {
    return await invoke<StoredCookie[]>("cookies_list", { jar });
  } catch {
    return [];
  }
}

export async function clearCookies(jar: string): Promise<void> {
  if (!inTauri) return;
  try {
    await invoke("cookies_clear", { jar });
  } catch {
    /* nothing held is the same outcome as cleared */
  }
}
