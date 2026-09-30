import { invoke } from "@tauri-apps/api/core";
import {
  COLLECTION_SUFFIX,
  parseCollection,
  redactStep,
  serializeCollection,
  suggestedCollectionFileName,
  textHash,
  type Collection,
  type CollectionFileLink,
} from "./collection";
import { inTauri } from "./request";
import { readStore, writeStore, STORE } from "./store";

/**
 * Where collections live: in Studio's own store, and optionally in a file in a
 * folder (a git repository, say) that Studio re-reads when it may have changed.
 *
 * The rule for a linked file is simple and errs on the side of not losing
 * anything: a file that changed on disk is reloaded if the collection has no
 * unsaved edits in Studio, and the user is asked which to keep if it has.
 * Saving never overwrites a file that changed since Studio last read it.
 */

export async function loadCollections(): Promise<Collection[]> {
  const stored = await readStore<Collection[]>(STORE.collections, []);
  return Array.isArray(stored) ? stored : [];
}

/**
 * Save the collections Studio keeps. Secret values are swapped for their
 * references and literal auth values left out, the same as in an exported file:
 * the store is a file on disk too.
 */
export async function saveCollections(collections: readonly Collection[]): Promise<void> {
  await writeStore(
    STORE.collections,
    collections.map((collection) => ({
      ...collection,
      steps: collection.steps.map((step) => redactStep(step).step),
    })),
  );
}

// ── a linked file ─────────────────────────────────────────────────────────────

export type DiskState =
  /** The file is as Studio last saw it. */
  | "unchanged"
  /** It changed, and nothing in Studio is unsaved: take the file. */
  | "reload"
  /** It changed, and so did the collection in Studio: ask. */
  | "conflict"
  /** It isn't there any more (moved, deleted, or on a drive that isn't mounted). */
  | "missing";

/** What to do about a linked file, given its text now (null when it can't be read). */
export function reconcile(link: CollectionFileLink, diskText: string | null): DiskState {
  if (diskText === null) return "missing";
  if (textHash(diskText) === link.syncedHash) return "unchanged";
  return link.dirty ? "conflict" : "reload";
}

/**
 * Whether saving may write the file: only if it is still what Studio last read,
 * or gone. Otherwise the save stops and the conflict is shown instead, so an
 * edit someone pulled from git is never silently overwritten.
 */
export function canOverwrite(link: CollectionFileLink, diskText: string | null): boolean {
  return diskText === null || textHash(diskText) === link.syncedHash;
}

/** The collection as the file says, keeping Studio's id and the link. */
export function fromDisk(current: Collection, path: string, text: string): Collection {
  const parsed = parseCollection(text, { filePath: path, id: current.id });
  return { ...parsed, file: { path, syncedHash: textHash(text), dirty: false } };
}

/** Keep the version in Studio: it becomes the one to save, over the file's. */
export function keepMine(collection: Collection, diskText: string): Collection {
  if (!collection.file) return collection;
  return { ...collection, file: { ...collection.file, syncedHash: textHash(diskText), dirty: true } };
}

// ── IO ────────────────────────────────────────────────────────────────────────

/** Read a linked file. Null when it can't be read. */
export async function readCollectionFile(path: string): Promise<string | null> {
  if (!inTauri) return null;
  try {
    return await invoke<string>("read_text", { path });
  } catch {
    return null;
  }
}

/**
 * Write a collection file. Rust only writes files whose names end in
 * `.spec0-collection.yaml`, so this command can't be pointed at anything else.
 */
export async function writeCollectionFile(path: string, text: string): Promise<void> {
  await invoke("write_collection", { path, contents: text });
}

/** Make sure a chosen path has the collection suffix. */
export function withCollectionSuffix(path: string): string {
  if (/\.spec0-collection\.ya?ml$/i.test(path)) return path;
  return `${path.replace(/\.ya?ml$/i, "")}${COLLECTION_SUFFIX}`;
}

/** Ask where to save a collection file. */
export async function pickCollectionSaveTarget(name: string): Promise<string | null> {
  if (!inTauri) return null;
  const { save } = await import("@tauri-apps/plugin-dialog");
  const picked = await save({
    defaultPath: suggestedCollectionFileName(name),
    filters: [{ name: "spec0 Studio collection", extensions: ["yaml", "yml"] }],
  });
  return typeof picked === "string" ? withCollectionSuffix(picked) : null;
}

/** Ask for a collection file to open or import, and read it. */
export async function pickCollectionFile(): Promise<{ path: string; text: string } | null> {
  if (!inTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    multiple: false,
    filters: [{ name: "spec0 Studio collection", extensions: ["yaml", "yml"] }],
  });
  if (typeof picked !== "string") return null;
  const text = await invoke<string>("read_text", { path: picked });
  return { path: picked, text };
}

/** In the browser preview there is no path to write, so an export downloads instead. */
export function downloadCollection(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/yaml" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = suggestedCollectionFileName(name);
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Serialize for a linked file, with spec paths relative to it. */
export function textForFile(collection: Collection, path: string) {
  return serializeCollection(collection, { filePath: path });
}
