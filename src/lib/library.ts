import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "./request";
import type { OAuthConfig } from "./oauth";
import { readStore, writeStore, STORE } from "./store";

/**
 * The library — the APIs you work with.
 *
 * This is what makes Studio a tool rather than a one-shot viewer. Opening a spec
 * used to replace the whole application; now it adds to a library you can come
 * back to, switch within, and leave.
 *
 * Note this is **not** Postman's collection model, which this product
 * rejects. A collection is a bag of requests that exists *because* there is no
 * spec. A library is a list of specs — each one still the organising primitive
 * for everything inside it.
 *
 * The document text is stored, not just a path: a dragged-in file has no stable
 * path, a file can move, and the free-tier promise is that a spec you've opened
 * keeps working with no network. Text lives in its own `spec_<id>.json` so the
 * index stays small and cheap to read on launch.
 */

export type SourceKind = "file" | "url" | "spec0" | "sample";

export interface ApiSource {
  kind: SourceKind;
  /** Path, URL, `spec0:<orgSlug>/<apiName>`, or `sample`. */
  ref: string;
}

/** State remembered per API, so returning to one picks up where you left off. */
export interface ApiState {
  server?: string;
  envId?: string | null;
  lastOperationId?: string | null;
  tab?: "operations" | "schemas" | "history";
  authScheme?: string | null;
  /** Which face of the document you were reading — raw text or the reference. */
  docTab?: "raw" | "reference";
}

export interface LibraryEntry {
  id: string;
  title: string;
  version: string;
  source: ApiSource;
  operations: number;
  schemas: number;
  addedAt: string;
  openedAt: string;
  /** Last successful pull, for url/spec0 sources. */
  syncedAt?: string;
  /**
   * Hosted mock for this API, captured at import. Kept on the entry rather than
   * looked up live so the mock stays selectable offline and after signing out —
   * and so "which target am I hitting" never depends on a network call.
   */
  mockUrl?: string;
  /** Captured when Studio created the mock — the API only ever returns it once. */
  mockApiKey?: string;
  /** The mock server's id, needed to refresh it. */
  mockServerId?: string;
  /**
   * The spec version the mock serves, when the platform reports it.
   *
   * Compared against the API's own version to tell version skew from real drift.
   * Preferred over {@link mockMayBeStale}, which is the timestamp heuristic used
   * when the platform predates this field.
   */
  mockSpecVersion?: string;
  /**
   * Fallback staleness signal: the spec was synced after the mock was attached.
   *
   * A heuristic — it says "something changed since", not "the mock is behind".
   * Only consulted when {@link mockSpecVersion} is unavailable.
   */
  mockMayBeStale?: boolean;
  /**
   * Where the platform says this API runs — cached so they survive going offline.
   *
   * Destinations only: a name and a URL. Stored on the entry rather than
   * fetched on demand so a signed-out or offline session still offers the targets it
   * knew about, the same way the spec itself keeps working.
   */
  environments?: EnvTargetEntry[];
  /** When the environment list was last pulled, so staleness can be shown honestly. */
  environmentsAt?: string;
  /**
   * How to obtain a token for this API.
   *
   * Configuration, not a credential: client id, URLs and scopes are properties
   * of the API. The client secret is *not* here — it's a `{{reference}}` into
   * the environment's secret store, so the app's "no per-API secret store" rule
   * holds rather than gaining an exception.
   */
  oauth?: OAuthConfig;
  /** Set when the catalog reports a newer version than the one stored here. */
  update?: AvailableUpdate;
  state?: ApiState;
}

/** What the catalog says is available upstream, recorded at check time. */
export interface AvailableUpdate {
  version?: string | null;
  updatedAt?: string | null;
  checkedAt: string;
}

const INDEX: LibraryEntry[] = [];

function specFile(id: string): string {
  // store_write only accepts flat names — no separators, no traversal.
  return `spec_${id}.json`;
}

/** Stable id from the source, so re-adding the same spec updates rather than duplicates. */
export function idForSource(source: ApiSource): string {
  let hash = 0;
  const key = `${source.kind}:${source.ref}`;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) | 0;
  }
  return `${source.kind}_${(hash >>> 0).toString(36)}`;
}

export async function loadLibrary(): Promise<LibraryEntry[]> {
  const entries = await readStore<LibraryEntry[]>(STORE.library, INDEX);
  return [...entries].sort((a, b) => b.openedAt.localeCompare(a.openedAt));
}

async function writeIndex(entries: LibraryEntry[]): Promise<void> {
  await writeStore(STORE.library, entries);
}

export async function readSpecText(id: string): Promise<string | null> {
  const wrapper = await readStore<{ text: string } | null>(specFile(id), null);
  return wrapper?.text || null;
}

async function writeSpecText(id: string, text: string): Promise<void> {
  await writeStore(specFile(id), { text });
}

/** A cached platform environment. Mirrors the public payload exactly — no extra fields. */
export interface EnvTargetEntry {
  name: string;
  url: string;
  currentVersion?: string | null;
}

export interface AddInput {
  title: string;
  version: string;
  source: ApiSource;
  text: string;
  operations: number;
  schemas: number;
  mockUrl?: string | null;
  mockApiKey?: string | null;
  mockServerId?: string | null;
  mockSpecVersion?: string | null;
}

/** Add a spec, or refresh it in place if the same source is already in the library. */
export async function addToLibrary(input: AddInput): Promise<LibraryEntry> {
  const entries = await loadLibrary();
  const id = idForSource(input.source);
  const now = new Date().toISOString();
  const existing = entries.find((entry) => entry.id === id);

  const entry: LibraryEntry = {
    id,
    title: input.title,
    version: input.version,
    source: input.source,
    operations: input.operations,
    schemas: input.schemas,
    addedAt: existing?.addedAt ?? now,
    openedAt: now,
    syncedAt: input.source.kind === "url" || input.source.kind === "spec0" ? now : undefined,
    mockUrl: input.mockUrl ?? existing?.mockUrl,
    mockApiKey: input.mockApiKey ?? existing?.mockApiKey,
    mockServerId: input.mockServerId ?? existing?.mockServerId,
    mockSpecVersion: input.mockSpecVersion ?? existing?.mockSpecVersion,
    // A fresh import is by definition current, so any pending update is resolved.
    mockMayBeStale: existing?.mockUrl ? true : undefined,
    update: undefined,
    state: existing?.state,
  };

  await writeSpecText(id, input.text);
  await writeIndex([entry, ...entries.filter((row) => row.id !== id)]);
  return entry;
}

export async function touchOpened(id: string): Promise<LibraryEntry[]> {
  const entries = await loadLibrary();
  const next = entries.map((entry) =>
    entry.id === id ? { ...entry, openedAt: new Date().toISOString() } : entry,
  );
  await writeIndex(next);
  return next;
}

export async function saveApiState(id: string, state: ApiState): Promise<LibraryEntry[]> {
  const entries = await loadLibrary();
  const next = entries.map((entry) =>
    entry.id === id ? { ...entry, state: { ...entry.state, ...state } } : entry,
  );
  await writeIndex(next);
  return next;
}

/** Record what the catalog says is newer than what we hold. */
export async function setUpdates(
  updates: Record<string, AvailableUpdate | undefined>,
): Promise<LibraryEntry[]> {
  const entries = await loadLibrary();
  const next = entries.map((entry) =>
    entry.id in updates ? { ...entry, update: updates[entry.id] } : entry,
  );
  await writeIndex(next);
  return next;
}

/** Replace the stored document after a sync, keeping the entry and its state. */
export async function applyUpdate(
  id: string,
  input: { text: string; title: string; version: string; operations: number; schemas: number },
): Promise<LibraryEntry[]> {
  const entries = await loadLibrary();
  const now = new Date().toISOString();
  await writeSpecText(id, input.text);
  const next = entries.map((entry) =>
    entry.id === id
      ? {
          ...entry,
          // The title is deliberately not overwritten: a user may have renamed it,
          // and a sync shouldn't undo that.
          version: input.version,
          operations: input.operations,
          schemas: input.schemas,
          syncedAt: now,
          openedAt: now,
          update: undefined,
          mockMayBeStale: entry.mockUrl ? true : undefined,
        }
      : entry,
  );
  await writeIndex(next);
  return next;
}

/**
 * Cache the environments the platform reports for an API.
 *
 * Replaces rather than merges: an environment removed upstream must disappear here
 * too, or a client keeps offering a target that may since have been reassigned to
 * something else entirely.
 */
export async function setEnvironments(
  id: string,
  environments: EnvTargetEntry[],
): Promise<LibraryEntry[]> {
  const entries = await loadLibrary();
  const next = entries.map((entry) =>
    entry.id === id
      ? { ...entry, environments, environmentsAt: new Date().toISOString() }
      : entry,
  );
  await writeIndex(next);
  return next;
}

/** Store this API's OAuth configuration. Never the secret — see {@link LibraryEntry.oauth}. */
export async function setOAuth(id: string, oauth: OAuthConfig | null): Promise<LibraryEntry[]> {
  const entries = await loadLibrary();
  const next = entries.map((entry) =>
    entry.id === id ? { ...entry, oauth: oauth ?? undefined } : entry,
  );
  await writeIndex(next);
  return next;
}

/** Store or replace the mock details for an API already in the library. */
export async function setMock(
  id: string,
  mock: {
    mockUrl?: string | null;
    mockApiKey?: string | null;
    mockServerId?: string | null;
    mockSpecVersion?: string | null;
    clearStale?: boolean;
  },
): Promise<LibraryEntry[]> {
  const entries = await loadLibrary();
  const next = entries.map((entry) =>
    entry.id === id
      ? {
          ...entry,
          mockUrl: mock.mockUrl ?? entry.mockUrl,
          mockApiKey: mock.mockApiKey ?? entry.mockApiKey,
          mockServerId: mock.mockServerId ?? entry.mockServerId,
          mockSpecVersion: mock.mockSpecVersion ?? entry.mockSpecVersion,
          // Attaching or refreshing a mock makes it current with the spec we hold.
          mockMayBeStale:
            mock.mockUrl || mock.clearStale ? undefined : entry.mockMayBeStale,
        }
      : entry,
  );
  await writeIndex(next);
  return next;
}

export async function renameEntry(id: string, title: string): Promise<LibraryEntry[]> {
  const entries = await loadLibrary();
  const next = entries.map((entry) => (entry.id === id ? { ...entry, title } : entry));
  await writeIndex(next);
  return next;
}

export async function removeEntry(id: string): Promise<LibraryEntry[]> {
  const entries = await loadLibrary();
  const next = entries.filter((entry) => entry.id !== id);
  await writeIndex(next);
  // Leave the spec blob; it's small, and re-adding the same source reuses the id.
  await writeSpecText(id, "");
  return next;
}

/** Re-read a file-backed spec from disk — only possible when we still have a path. */
export async function rereadFile(entry: LibraryEntry): Promise<string | null> {
  if (entry.source.kind !== "file" || !inTauri) return null;
  try {
    return await invoke<string>("read_text", { path: entry.source.ref });
  } catch {
    return null;
  }
}

export function sourceLabel(source: ApiSource): string {
  switch (source.kind) {
    case "file":
      return source.ref.split("/").pop() ?? "file";
    case "url":
      return source.ref.replace(/^https?:\/\//, "");
    case "spec0":
      return source.ref.replace(/^spec0:/, "");
    case "sample":
      return "sample";
  }
}

export function relativeTime(iso: string | undefined): string {
  if (!iso) return "";
  const delta = Date.now() - Date.parse(iso);
  if (Number.isNaN(delta)) return "";
  const minutes = Math.round(delta / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}
