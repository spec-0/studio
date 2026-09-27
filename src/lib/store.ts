import { invoke } from "@tauri-apps/api/core";
import { fileName } from "./platform";
import { inTauri } from "./request";

/**
 * Persistence.
 *
 * Inside Tauri these are narrow Rust commands writing plain JSON into the app's
 * config directory — inspectable and portable: plain files, not a database.
 * In the browser preview they fall back to localStorage so
 * the UI can be worked on without a native rebuild.
 */

export const STORE = {
  settings: "settings.json",
  environments: "environments.json",
  /**
   * Secret values that couldn't go to the OS credential store — the fallback,
   * and the file older versions kept every secret in. See `secrets.ts`.
   */
  secrets: "secrets.json",
  history: "history.json",
  session: "session.json",
  library: "library.json",
  /** The scratch pad's contents — a text buffer, not a saved request. */
  scratch: "scratch.json",
  /** How we reach hosts: certificate trust, proxy, timeout, redirects. */
  connection: "connection.json",
  /**
   * Acquired OAuth tokens — cache, not configuration.
   *
   * Kept out of `library.json` deliberately: an access token is a credential, so
   * it belongs with the other uncommitted machine-managed state, never in the
   * index that describes the APIs.
   */
  tokens: "tokens.json",
  /** Whether to check for a new version of Studio at start. Off by default. */
  updates: "updates.json",
} as const;

/** Fixed files above, plus per-API blobs like `spec_<id>.json`. */
export type StoreName = (typeof STORE)[keyof typeof STORE] | (string & {});

export async function readStore<T>(name: StoreName, fallback: T): Promise<T> {
  try {
    const raw = inTauri
      ? await invoke<string | null>("store_read", { name })
      : window.localStorage.getItem(`studio:${name}`);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export async function writeStore<T>(name: StoreName, value: T): Promise<void> {
  const contents = JSON.stringify(value, null, 2);
  try {
    if (inTauri) await invoke("store_write", { name, contents });
    else window.localStorage.setItem(`studio:${name}`, contents);
  } catch {
    // Persistence failing shouldn't take the session down with it.
  }
}

export async function deleteStore(name: StoreName): Promise<void> {
  try {
    if (inTauri) await invoke("store_delete", { name });
    else window.localStorage.removeItem(`studio:${name}`);
  } catch {
    // Same as writing: a failure here must not take the session down.
  }
}

export async function storeLocation(): Promise<string> {
  if (!inTauri) return "browser localStorage";
  try {
    return await invoke<string>("store_location");
  } catch {
    return "unknown";
  }
}

/** Open a native file picker and read what the user chose. */
export async function pickSpecFile(): Promise<{ path: string; text: string } | null> {
  if (!inTauri) return null; // browser uses a hidden <input type=file>
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    multiple: false,
    filters: [{ name: "OpenAPI", extensions: ["yaml", "yml", "json"] }],
  });
  if (typeof picked !== "string") return null;
  const text = await invoke<string>("read_text", { path: picked });
  return { path: picked, text };
}

/**
 * Pick a CA bundle and read it.
 *
 * The content is what gets stored, not the path: the dialog is the consent step
 * for reading this file, and re-reading a path at send time would need a
 * permission story that buys nothing over holding the PEM we were handed.
 */
export async function pickCertificate(): Promise<{ name: string; text: string } | null> {
  if (!inTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    multiple: false,
    filters: [{ name: "Certificates", extensions: ["pem", "crt", "cer", "ca-bundle"] }],
  });
  if (typeof picked !== "string") return null;
  const text = await invoke<string>("read_text", { path: picked });
  return { name: fileName(picked), text };
}

/** Pick any file, for a multipart part. Only its path travels — Rust reads it. */
export async function pickAnyFile(): Promise<{ path: string; name: string } | null> {
  if (!inTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ multiple: false });
  if (typeof picked !== "string") return null;
  return { path: picked, name: fileName(picked) };
}

/** Where to write a response body the user asked to keep. */
export async function pickSaveTarget(suggested: string): Promise<string | null> {
  if (!inTauri) return null;
  const { save } = await import("@tauri-apps/plugin-dialog");
  const picked = await save({ defaultPath: suggested });
  return typeof picked === "string" ? picked : null;
}

/** Copy a held response body to the chosen path. */
export async function saveResponseTo(from: string, to: string): Promise<void> {
  await invoke("save_response", { from, to });
}

export async function openExternal(url: string): Promise<void> {
  if (!inTauri) {
    window.open(url, "_blank", "noopener");
    return;
  }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

/** Wait for the browser to redirect back to `127.0.0.1:<port>/callback`. */
export async function awaitOAuthCallback(
  port: number,
  timeoutSecs = 120,
): Promise<Record<string, string>> {
  if (!inTauri) throw new Error("Browser sign-in needs the desktop app.");
  return invoke<Record<string, string>>("oauth_listen", { port, timeoutSecs });
}

export interface CliOrgConfig {
  apiUrl: string;
  apiKey?: string;
  orgName?: string;
  keyName?: string;
}

/** The spec0 CLI's stored session, if the user already has one. */
export async function readCliSession(): Promise<{ orgId: string; config: CliOrgConfig } | null> {
  if (!inTauri) return null;
  try {
    const raw = await invoke<string | null>("cli_config");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { orgs?: Record<string, CliOrgConfig> };
    const entries = Object.entries(parsed.orgs ?? {});
    if (!entries.length) return null;
    const [orgId, config] = entries[0]; // single-org model, same as the CLI
    return config?.apiKey ? { orgId, config } : null;
  } catch {
    return null;
  }
}

/** A recently opened spec, for the launch screen. */
export interface RecentSpec {
  name: string;
  /** File path, URL, or `spec0:<orgSlug>/<apiName>`. */
  source: string;
  kind: "file" | "url" | "spec0";
  openedAt: string;
}
