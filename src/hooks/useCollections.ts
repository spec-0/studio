import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { StepOutput } from "../lib/chain";
import {
  moveStep as moveStepIn,
  newCollection,
  parseCollection,
  renameStepKey as renameIn,
  serializeCollection,
  statusMatches,
  textHash,
  uniqueStepKey,
  type Collection,
  type CollectionStep,
  type StepAuth,
} from "../lib/collection";
import {
  canOverwrite,
  downloadCollection,
  fromDisk,
  keepMine,
  loadCollections,
  pickCollectionFile,
  pickCollectionSaveTarget,
  readCollectionFile,
  reconcile,
  saveCollections,
  textForFile,
  writeCollectionFile,
} from "../lib/collectionFile";
import type { AddedNote, AddMenuState } from "../components/collections/AddToCollection";
import type { RequestValues } from "../components/OperationView";
import {
  addOperationStep,
  describeTarget,
  findLibraryEntry,
  inputsFromEditor,
  localMockAddress,
  targetFromAddress,
  linkStep,
  relinkStep as relinkIn,
  removeStep as removeIn,
  resolveTarget,
  stepValuesFromHistory,
  type StepLink,
  type StepValues,
} from "../lib/collectionLink";
import { detectImportFormat } from "../lib/collectionImport";
import { importPostman, type EnvironmentDraft, type ImportSummary } from "../lib/postman";
import { logToConsole } from "../lib/appConsole";
import {
  describeRun,
  mockWarnings,
  planStep,
  runSteps,
  summariseRun,
  verdictFor,
  type StepDescription,
  type StepResult,
  type TargetKind,
} from "../lib/collectionRun";
import { transportFor, type ConnectionSettings } from "../lib/connection";
import * as history from "../lib/history";
import type { HistoryEntry } from "../lib/history";
import * as library from "../lib/library";
import { documentUrlOf, type LibraryEntry } from "../lib/library";
import { isExpired, loadToken, refreshAccessToken, saveToken } from "../lib/oauth";
import { fileName } from "../lib/platform";
import { appFetch, describeBody, inTauri, send, type AuthState } from "../lib/request";
import { declaredResponse, describeSendError, storedResponseBody } from "../lib/response";
import { SCRATCH_OPERATION_ID, SCRATCH_TITLE, scratchPath } from "../lib/scratch";
import { parseSpec, type OperationSpec, type ParsedSpec } from "../lib/spec";
import { DEFAULT_API_URL, absoluteMockUrl, type Session } from "../lib/spec0";
import { mockCredentials } from "../lib/targets";
import { validateResponse, type ValidationResult } from "../lib/validate";
import { useRunLogs } from "./useRunLogs";

/** A run of one collection, as the view shows it. */
export interface CollectionRunState {
  runId: string;
  at: string;
  running: boolean;
  results: StepResult[];
}

/** Something to say at the top of the collection: a warning after export, a file problem. */
export interface CollectionNotice {
  kind: "info" | "warn" | "error";
  text: string;
  lines?: string[];
}

/** A Postman collection just imported: what happened, and the environment on offer. */
export interface ImportOutcome {
  collectionId: string;
  summary: ImportSummary;
  environment: EnvironmentDraft | null;
}

/** The file changed on disk and the collection has unsaved edits. */
export interface FileConflict {
  diskText: string;
}

/** A spec is cached under the library entry and the version of the text it holds. */
const specKey = (entry: LibraryEntry) =>
  `${entry.id}|${entry.version}|${entry.syncedAt ?? ""}|${entry.operations}|${entry.schemas}`;

/** An auth state for sending, from what a step stores. */
export function authOf(step: CollectionStep): AuthState | null {
  if (!step.auth?.scheme) return null;
  const { scheme, ...rest } = step.auth;
  return { ...rest, schemeName: scheme };
}

/** What a step stores, from the editor's auth state. */
export function stepAuthOf(auth: AuthState | null): StepAuth | undefined {
  if (!auth?.schemeName) return undefined;
  const { schemeName, ...rest } = auth;
  const clean = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as Omit<StepAuth, "scheme">;
  return { ...clean, scheme: schemeName, value: auth.value ?? "" };
}

/**
 * Collections: kept in Studio, optionally linked to a file in a folder, edited,
 * and run.
 *
 * A linked file is re-read when a collection is opened and whenever the window
 * comes back into focus, since that's when someone may have pulled a change or
 * edited it by hand. See `src/lib/collectionFile.ts` for what happens then.
 */
export function useCollections({
  entries,
  setEntries,
  session,
  vars,
  activeEnv,
  connection,
  setRequests,
  showCollections,
  localMocks,
  addEnvironment,
}: {
  entries: LibraryEntry[];
  setEntries: Dispatch<SetStateAction<LibraryEntry[]>>;
  session: Session | null;
  vars: Record<string, string>;
  activeEnv: { id: string; name: string } | null;
  connection: ConnectionSettings;
  setRequests: Dispatch<SetStateAction<HistoryEntry[]>>;
  /** Go to the Collections tab. */
  showCollections: () => void;
  /** Local mocks: which run (library id → port), and starting one. */
  localMocks: {
    running: Record<string, number>;
    available: boolean;
    start: (entry: LibraryEntry) => Promise<void>;
  };
  /** Create an environment (and make it active), e.g. from an imported collection's variables. */
  addEnvironment: (draft: EnvironmentDraft) => void;
}) {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedStep, setSelectedStep] = useState(0);
  const [specs, setSpecs] = useState<Map<string, ParsedSpec | null>>(new Map());
  const specVersions = useRef(new Map<string, string>());
  const [runs, setRuns] = useState<Record<string, CollectionRunState>>({});
  const [notices, setNotices] = useState<Record<string, CollectionNotice | null>>({});
  const [conflicts, setConflicts] = useState<Record<string, FileConflict | null>>({});
  /** Bumped when a collection is replaced from outside the editor, so the step editor re-reads it. */
  const [revision, setRevision] = useState(0);
  const cancelled = useRef(new Set<string>());
  const latest = useRef(collections);
  latest.current = collections;
  const runLogs = useRunLogs(
    useMemo(() => collections.map((c) => c.id), [collections]),
    loaded,
  );

  // ── storage ────────────────────────────────────────────────────────────────

  useEffect(() => {
    void loadCollections().then((stored) => {
      setCollections(stored);
      setSelectedId((id) => id ?? stored[0]?.id ?? null);
      setLoaded(true);
    });
  }, []);

  /** Replace the list and save it. Every change goes through here. */
  const commit = useCallback((next: Collection[]) => {
    latest.current = next;
    setCollections(next);
    void saveCollections(next);
  }, []);

  const notify = useCallback((id: string, notice: CollectionNotice | null) => {
    setNotices((prev) => ({ ...prev, [id]: notice }));
  }, []);

  /**
   * Change one collection. A linked one is marked as having unsaved edits; the
   * file is only written when the user saves.
   */
  const update = useCallback(
    (id: string, change: (collection: Collection) => Collection) => {
      const next = latest.current.map((collection) => {
        if (collection.id !== id) return collection;
        const changed = change(collection);
        if (changed === collection) return collection;
        return {
          ...changed,
          updatedAt: new Date().toISOString(),
          ...(changed.file ? { file: { ...changed.file, dirty: true } } : {}),
        };
      });
      commit(next);
    },
    [commit],
  );

  const replace = useCallback(
    (collection: Collection) => {
      commit(latest.current.map((c) => (c.id === collection.id ? collection : c)));
      setRevision((n) => n + 1);
    },
    [commit],
  );

  const selected = collections.find((c) => c.id === selectedId) ?? null;

  // ── specs ──────────────────────────────────────────────────────────────────

  /** Read and parse the specs a collection needs, keeping those already read. */
  const ensureSpecs = useCallback(
    async (collection: Collection): Promise<Map<string, ParsedSpec | null>> => {
      const wanted = new Map<string, LibraryEntry>();
      for (const api of Object.values(collection.apis)) {
        const entry = findLibraryEntry(api, entries);
        if (entry) wanted.set(entry.id, entry);
      }
      const missing = [...wanted.values()].filter(
        (entry) => specVersions.current.get(entry.id) !== specKey(entry),
      );
      if (!missing.length) return specs;
      const loadedSpecs = await Promise.all(
        missing.map(async (entry) => {
          try {
            const text = await library.readSpecText(entry.id);
            return [entry, text ? parseSpec(text, entry.title, documentUrlOf(entry.source)) : null] as const;
          } catch {
            return [entry, null] as const;
          }
        }),
      );
      const next = new Map(specs);
      for (const [entry, spec] of loadedSpecs) {
        next.set(entry.id, spec);
        specVersions.current.set(entry.id, specKey(entry));
      }
      setSpecs(next);
      return next;
    },
    [entries, specs],
  );

  useEffect(() => {
    if (selected) void ensureSpecs(selected);
  }, [selected, ensureSpecs]);

  /** Read one library entry's spec, for picking an operation to link a step to. */
  const specForEntry = useCallback(
    async (entry: LibraryEntry): Promise<ParsedSpec | null> => {
      if (specVersions.current.get(entry.id) === specKey(entry)) return specs.get(entry.id) ?? null;
      try {
        const text = await library.readSpecText(entry.id);
        const spec = text ? parseSpec(text, entry.title, documentUrlOf(entry.source)) : null;
        specVersions.current.set(entry.id, specKey(entry));
        setSpecs((prev) => new Map(prev).set(entry.id, spec));
        return spec;
      } catch {
        return null;
      }
    },
    [specs],
  );

  /** Every step of the selected collection against its spec. */
  const links: StepLink[] = useMemo(
    () => (selected ? selected.steps.map((step) => linkStep(step, selected, entries, specs)) : []),
    [selected, entries, specs],
  );

  const mockUrlFor = useCallback(
    (entry: LibraryEntry) => absoluteMockUrl(session?.apiUrl ?? DEFAULT_API_URL, entry.mockUrl) ?? null,
    [session?.apiUrl],
  );

  // ── the linked file ────────────────────────────────────────────────────────

  const checkDisk = useCallback(
    async (collection: Collection) => {
      if (!collection.file) return;
      const text = await readCollectionFile(collection.file.path);
      const state = reconcile(collection.file, text);
      if (state === "unchanged") {
        setConflicts((prev) => (prev[collection.id] ? { ...prev, [collection.id]: null } : prev));
        return;
      }
      if (state === "missing") {
        notify(collection.id, {
          kind: "warn",
          text: `${fileName(collection.file.path)} can't be read any more. It may have been moved or deleted. Save it again, or stop linking it.`,
        });
        return;
      }
      if (state === "conflict") {
        setConflicts((prev) => ({ ...prev, [collection.id]: { diskText: text! } }));
        return;
      }
      try {
        replace(fromDisk(collection, collection.file.path, text!));
        notify(collection.id, { kind: "info", text: `Reloaded: ${fileName(collection.file.path)} changed on disk.` });
      } catch (error) {
        notify(collection.id, {
          kind: "error",
          text: `${fileName(collection.file.path)} changed on disk but can't be read: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    },
    [notify, replace],
  );

  // Re-read linked files when a collection opens and when the window regains focus.
  useEffect(() => {
    if (selected?.file) void checkDisk(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  useEffect(() => {
    const onFocus = () => {
      if (document.visibilityState === "hidden") return;
      for (const collection of latest.current) if (collection.file) void checkDisk(collection);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [checkDisk]);

  const resolveConflict = useCallback(
    (id: string, keep: "mine" | "file") => {
      const collection = latest.current.find((c) => c.id === id);
      const conflict = conflicts[id];
      if (!collection?.file || !conflict) return;
      if (keep === "mine") {
        replace(keepMine(collection, conflict.diskText));
        notify(id, { kind: "info", text: "Kept the version in Studio. Save to write it to the file." });
      } else {
        try {
          replace(fromDisk(collection, collection.file.path, conflict.diskText));
          notify(id, { kind: "info", text: "Replaced with the file's version." });
        } catch (error) {
          notify(id, { kind: "error", text: error instanceof Error ? error.message : String(error) });
        }
      }
      setConflicts((prev) => ({ ...prev, [id]: null }));
    },
    [conflicts, replace, notify],
  );

  const writeTo = useCallback(
    async (collection: Collection, path: string) => {
      const { text, warnings } = textForFile(collection, path);
      await writeCollectionFile(path, text);
      replace({ ...collection, file: { path, syncedHash: textHash(text), dirty: false } });
      notify(
        collection.id,
        warnings.length
          ? { kind: "warn", text: `Saved to ${fileName(path)}, without some values:`, lines: warnings }
          : { kind: "info", text: `Saved to ${fileName(path)}.` },
      );
    },
    [replace, notify],
  );

  /** Save a linked collection to its file — unless the file changed since it was read. */
  const save = useCallback(
    async (id: string) => {
      const collection = latest.current.find((c) => c.id === id);
      if (!collection?.file) return;
      const disk = await readCollectionFile(collection.file.path);
      if (!canOverwrite(collection.file, disk)) {
        setConflicts((prev) => ({ ...prev, [id]: { diskText: disk! } }));
        return;
      }
      try {
        await writeTo(collection, collection.file.path);
      } catch (error) {
        notify(id, { kind: "error", text: `Couldn't save: ${error instanceof Error ? error.message : String(error)}` });
      }
    },
    [writeTo, notify],
  );

  /** Save to a file in a folder of the user's choosing, and keep the collection linked to it. */
  const saveToFolder = useCallback(
    async (id: string) => {
      const collection = latest.current.find((c) => c.id === id);
      if (!collection) return;
      const path = await pickCollectionSaveTarget(collection.name);
      if (!path) return;
      try {
        await writeTo(collection, path);
      } catch (error) {
        notify(id, { kind: "error", text: `Couldn't save: ${error instanceof Error ? error.message : String(error)}` });
      }
    },
    [writeTo, notify],
  );

  /** Write a copy to a file. The collection stays as it is in Studio. */
  const exportCollection = useCallback(
    async (id: string) => {
      const collection = latest.current.find((c) => c.id === id);
      if (!collection) return;
      try {
        let warnings: string[];
        let where: string;
        if (inTauri) {
          const path = await pickCollectionSaveTarget(collection.name);
          if (!path) return;
          const out = serializeCollection(collection, { filePath: path });
          await writeCollectionFile(path, out.text);
          warnings = out.warnings;
          where = fileName(path);
        } else {
          const out = serializeCollection(collection);
          downloadCollection(collection.name, out.text);
          warnings = out.warnings;
          where = "a download";
        }
        notify(
          id,
          warnings.length
            ? { kind: "warn", text: `Exported to ${where}, without some values:`, lines: warnings }
            : { kind: "info", text: `Exported to ${where}. Secret values are written as {{references}}.` },
        );
      } catch (error) {
        notify(id, { kind: "error", text: `Couldn't export: ${error instanceof Error ? error.message : String(error)}` });
      }
    },
    [notify],
  );

  const stopLinking = useCallback(
    (id: string) => {
      const collection = latest.current.find((c) => c.id === id);
      if (!collection?.file) return;
      const { file: _file, ...rest } = collection;
      replace(rest);
      notify(id, { kind: "info", text: "Kept in Studio only. The file is unchanged." });
    },
    [replace, notify],
  );

  /** A problem reading a file, shown in the list's place since no collection owns it yet. */
  const [openError, setOpenError] = useState<string | null>(null);

  /**
   * Add a collection from a file's text. `link` keeps it tied to the file (open
   * from a folder); otherwise it is a copy (import).
   */
  const addFromText = useCallback(
    (text: string, path: string | null, link: boolean) => {
      setOpenError(null);
      try {
        if (link && path) {
          const existing = latest.current.find((c) => c.file?.path === path);
          if (existing) {
            setSelectedId(existing.id);
            void checkDisk(existing);
            return;
          }
        }
        const parsed = parseCollection(text, path ? { filePath: path } : {});
        const collection: Collection =
          link && path ? { ...parsed, file: { path, syncedHash: textHash(text), dirty: false } } : parsed;
        commit([...latest.current, collection]);
        setSelectedId(collection.id);
        setSelectedStep(0);
      } catch (error) {
        setOpenError(`${path ? fileName(path) : "That file"}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [commit, checkDisk],
  );

  const [imported, setImported] = useState<ImportOutcome | null>(null);

  /**
   * Import a file of any kind Studio reads: its own collection format, or a
   * Postman collection, matched against every API in the library. Anything
   * else is refused with a message saying what the file is.
   */
  const importText = useCallback(
    async (text: string, path: string | null) => {
      setOpenError(null);
      const format = detectImportFormat(text);
      if (format.kind === "studio") return addFromText(text, path, false);
      if (format.kind === "unsupported") {
        setOpenError(`${path ? `${fileName(path)}: ` : ""}${format.message}`);
        return;
      }
      try {
        const read = await Promise.all(entries.map(async (entry) => [entry.id, await specForEntry(entry)] as const));
        const result = importPostman(format.data, { entries, specs: new Map(read) });
        commit([...latest.current, result.collection]);
        setSelectedId(result.collection.id);
        setSelectedStep(0);
        setImported({ collectionId: result.collection.id, summary: result.summary, environment: result.environment });
      } catch (error) {
        setOpenError(
          `${path ? fileName(path) : "That file"}: couldn't import it: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    [addFromText, entries, specForEntry, commit],
  );

  /** Close the import summary, creating the environment if the user asked for it. */
  const finishImport = useCallback(
    (environment: EnvironmentDraft | null) => {
      if (environment) addEnvironment(environment);
      setImported(null);
    },
    [addEnvironment],
  );

  const openFromFile = useCallback(
    async (link: boolean) => {
      try {
        const picked = await pickCollectionFile(!link);
        if (!picked) return;
        if (link) addFromText(picked.text, picked.path, true);
        else await importText(picked.text, picked.path);
      } catch (error) {
        setOpenError(error instanceof Error ? error.message : String(error));
      }
    },
    [addFromText, importText],
  );

  // ── editing ────────────────────────────────────────────────────────────────

  const create = useCallback(
    (name: string, steps?: (collection: Collection) => Collection): Collection => {
      let collection = newCollection(name);
      if (steps) collection = steps(collection);
      commit([...latest.current, collection]);
      setSelectedId(collection.id);
      setSelectedStep(0);
      return collection;
    },
    [commit],
  );

  /** A name no other collection has: "New collection", "New collection 2"… */
  const freshName = useCallback((base = "New collection") => {
    const names = new Set(latest.current.map((c) => c.name));
    if (!names.has(base)) return base;
    for (let n = 2; ; n += 1) if (!names.has(`${base} ${n}`)) return `${base} ${n}`;
  }, []);

  const remove = useCallback(
    (id: string) => {
      const next = latest.current.filter((c) => c.id !== id);
      commit(next);
      setSelectedId((current) => (current === id ? (next[0]?.id ?? null) : current));
    },
    [commit],
  );

  const rename = useCallback((id: string, name: string) => update(id, (c) => ({ ...c, name })), [update]);

  const setStopOnFailure = useCallback(
    (id: string, stopOnFailure: boolean) => update(id, (c) => ({ ...c, stopOnFailure })),
    [update],
  );

  const updateStep = useCallback(
    (id: string, index: number, change: (step: CollectionStep) => CollectionStep) =>
      update(id, (c) => {
        const step = c.steps[index];
        if (!step) return c;
        const next = change(step);
        return next === step ? c : { ...c, steps: c.steps.map((s, i) => (i === index ? next : s)) };
      }),
    [update],
  );

  const renameStepKey = useCallback(
    (id: string, from: string, to: string): string | null => {
      try {
        const collection = latest.current.find((c) => c.id === id);
        if (!collection) return null;
        renameIn(collection, from, to);
        update(id, (c) => renameIn(c, from, to));
        setRevision((n) => n + 1);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    [update],
  );

  const moveStep = useCallback(
    (id: string, from: number, to: number) => {
      update(id, (c) => moveStepIn(c, from, to));
      setSelectedStep(Math.max(0, to));
    },
    [update],
  );

  const removeStep = useCallback(
    (id: string, index: number) => {
      update(id, (c) => removeIn(c, index));
      setSelectedStep((current) => Math.max(0, current >= index ? current - 1 : current));
    },
    [update],
  );

  const relinkStep = useCallback(
    (id: string, index: number, entry: LibraryEntry, op: OperationSpec) => {
      update(id, (c) => relinkIn(c, index, entry, op));
      setRevision((n) => n + 1);
    },
    [update],
  );

  /**
   * Add an operation as a step, to an existing collection or to a new one
   * (`collectionId` null). Returns the collection it went into.
   */
  const addOperation = useCallback(
    (
      collectionId: string | null,
      entry: LibraryEntry,
      spec: ParsedSpec,
      op: OperationSpec,
      values?: StepValues,
      target?: Parameters<typeof addOperationStep>[5],
      auth?: StepAuth,
    ): Collection | null => {
      const add = (c: Collection) => {
        const next = addOperationStep(c, entry, spec, op, values, target);
        if (!auth) return next;
        const steps = [...next.steps];
        steps[steps.length - 1] = { ...steps[steps.length - 1], auth };
        return { ...next, steps };
      };
      // The spec is already parsed; keep it, so the new step shows at once.
      specVersions.current.set(entry.id, specKey(entry));
      setSpecs((prev) => (prev.get(entry.id) === spec ? prev : new Map(prev).set(entry.id, spec)));
      if (!collectionId) return create(freshName(), add);
      update(collectionId, add);
      const after = latest.current.find((c) => c.id === collectionId) ?? null;
      return after;
    },
    [create, freshName, update],
  );

  /**
   * Add a recorded request as a step, keeping the values that were sent. A
   * request whose operation is known becomes a linked step; a scratch request
   * (or one whose operation is gone) becomes an unlinked one, to link later.
   */
  const addRecorded = useCallback(
    (collectionId: string | null, record: HistoryEntry, spec: ParsedSpec | null): Collection | null => {
      const entry = record.apiId ? entries.find((e) => e.id === record.apiId) : undefined;
      const op = spec?.operations.find((o) => o.id === record.operationId);
      if (entry && spec && op) {
        return addOperation(collectionId, entry, spec, op, stepValuesFromHistory(record, op));
      }
      const add = (c: Collection): Collection => {
        const headers = stepValuesFromHistory(record, {
          id: "",
          method: record.method,
          path: "/",
          tag: "",
          deprecated: false,
          parameters: [],
          responses: [],
        }).headers;
        const step: CollectionStep = {
          key: uniqueStepKey(
            `${record.method.toLowerCase()}Request`,
            c.steps.map((s) => s.key),
          ),
          request: { method: record.method, url: record.url },
          pathParams: {},
          queryParams: {},
          headers: headers ?? {},
          ...(record.body !== undefined && (record.bodyKind ?? "text") === "text" ? { body: record.body } : {}),
        };
        return { ...c, steps: [...c.steps, step] };
      };
      if (!collectionId) return create(freshName(), add);
      update(collectionId, add);
      return latest.current.find((c) => c.id === collectionId) ?? null;
    },
    [entries, addOperation, create, freshName, update],
  );

  // ── running ────────────────────────────────────────────────────────────────

  const tokenFor = useCallback(
    async (entry: LibraryEntry): Promise<string> => {
      const envId = activeEnv?.id ?? null;
      let token = await loadToken(entry.id, envId);
      if (token && isExpired(token) && token.refreshToken && entry.oauth) {
        try {
          token = await refreshAccessToken(entry.oauth, token, vars, transportFor(connection, entry.oauth.tokenUrl));
          await saveToken(entry.id, envId, token);
        } catch {
          // As for a single request: the old token may still work, and the
          // API's 401 says more than a refresh error would.
        }
      }
      return token?.accessToken ?? "";
    },
    [activeEnv?.id, vars, connection],
  );

  const run = useCallback(
    async (id: string) => {
      const collection = latest.current.find((c) => c.id === id);
      if (!collection || runs[id]?.running) return;
      const runId = `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
      const at = new Date().toISOString();
      cancelled.current.delete(id);
      setRuns((prev) => ({ ...prev, [id]: { runId, at, running: true, results: [] } }));
      const specsNow = await ensureSpecs(collection);
      const keys = collection.steps.map((s) => s.key);
      const total = collection.steps.length;

      /** A step as the run log first shows it: name, method, where it goes. */
      const describe = (step: CollectionStep): StepDescription => {
        const name = step.name || step.key;
        const link = linkStep(step, collection, entries, specsNow);
        if (link.kind === "ok" || link.kind === "stale") {
          return {
            name,
            method: link.op.method,
            target: describeTarget(step.target, link.spec),
            targetKind: step.target?.kind ?? "server",
          };
        }
        if (step.request) return { name, method: step.request.method, url: step.request.url, targetKind: "url" };
        return { name, ...(step.operation ? { method: step.operation.method } : {}) };
      };
      const described = collection.steps.map(describe);
      const targets = [...new Set(described.map((d) => d.target ?? d.url ?? "").filter(Boolean))];
      const logged = { collection: { id: collection.id, name: collection.name }, runId, environment: activeEnv?.name ?? null };
      logToConsole({
        source: "collection",
        level: "info",
        run: { collectionId: collection.id, runId },
        text: `Run started: ${collection.name} · ${total} step${total === 1 ? "" : "s"}${activeEnv ? ` · ${activeEnv.name}` : ""}`,
      });

      const execute = async (
        step: CollectionStep,
        outputs: ReadonlyMap<string, StepOutput>,
        index: number,
        emit: Parameters<Parameters<typeof runSteps>[1]>[3],
      ): Promise<StepResult> => {
        const link = linkStep(step, collection, entries, specsNow);
        if (link.kind === "unresolved") return { key: step.key, verdict: "fail", reason: link.reason };
        if (link.kind === "loading") return { key: step.key, verdict: "fail", reason: `${link.entry.title} couldn't be read.` };

        const linked = link.kind === "ok" || link.kind === "stale" ? link : null;
        let baseUrl = "";
        let mock: ReturnType<typeof mockCredentials> = null;
        let toMock = false;
        if (linked) {
          const mockUrl = mockUrlFor(linked.entry);
          const target = resolveTarget(step.target, {
            servers: linked.spec.servers,
            mockUrl,
            localMockUrl: localMockAddress(localMocks.running[linked.entry.id]),
          });
          if ("error" in target) return { key: step.key, verdict: "fail", reason: target.error };
          baseUrl = target.url;
          toMock = target.mock;
          // The hosted mock's key only goes to the hosted mock (buildPlan checks the address).
          mock = mockCredentials(mockUrl, linked.entry.mockApiKey, session);
        }
        let auth = authOf(step);
        if (auth?.type === "oauth2") auth = { ...auth, value: linked ? await tokenFor(linked.entry) : "" };

        const planned = planStep(step, {
          op: linked?.op ?? null,
          baseUrl,
          vars,
          keys,
          outputs,
          auth,
          mock,
        });
        if (planned.links?.length) emit({ type: "references_resolved", links: planned.links });
        if ("error" in planned) return { key: step.key, verdict: "fail", reason: planned.error };
        const plan = planned.plan;

        const targetKind: TargetKind = linked ? (step.target?.kind ?? "server") : "url";
        emit({ type: "request_sent", method: plan.method, url: plan.url, headers: plan.headers, targetKind });
        let response;
        try {
          response = await send(plan, { ...transportFor(connection, plan.url), jar: linked?.entry.id ?? "__scratch__" });
        } catch (error) {
          const reason = describeSendError(error, inTauri);
          emit({ type: "request_failed", error: reason });
          return { key: step.key, verdict: "fail", reason, request: plan };
        }
        let validation: ValidationResult | null = null;
        if (linked) {
          const declared = declaredResponse(linked.op.responses, response.status);
          validation = validateResponse(linked.spec.doc, declared?.schema, response.json);
        }
        const warned = mockWarnings(response.headers);
        emit({
          type: "response_received",
          status: response.status,
          statusText: response.statusText,
          ms: response.ms,
          bytes: response.bytes,
          ...(warned.length ? { warnings: warned } : {}),
        });
        emit({
          type: "status_check",
          expected: step.expect?.status ?? "2xx",
          actual: response.status,
          ok: statusMatches(step.expect?.status, response.status),
        });
        emit(
          validation
            ? {
                type: "schema_check",
                result:
                  validation.status === "no_schema" ? "not_checked" : validation.status === "ok" ? "ok" : validation.status,
                findings: validation.findings.length,
                ...(validation.note ? { note: validation.note } : {}),
              }
            : { type: "schema_check", result: "not_checked", findings: 0, note: "this request isn't linked to an operation" },
        );
        const checked = verdictFor(response.status, validation, step.expect?.status);
        const { verdict } = checked;
        // The mock answered, so the step passes on its response, but a request
        // the spec wouldn't accept is worth saying next to that pass.
        const reason =
          warned.length && verdict === "pass"
            ? `${checked.reason ? `${checked.reason} ` : ""}The local mock says the request doesn't match the spec.`
            : checked.reason;
        const output: StepOutput = {
          status: response.status,
          headers: response.headers,
          json: response.json,
          text: response.bodyText,
        };
        await history.record({
          method: plan.method,
          path: linked ? linked.op.path : scratchPath(plan.url),
          url: plan.url,
          status: response.status,
          ms: response.ms,
          bytes: response.bytes,
          specTitle: linked ? linked.spec.title || linked.entry.title : SCRATCH_TITLE,
          operationId: linked ? linked.op.id : SCRATCH_OPERATION_ID,
          ...(linked ? { apiId: linked.entry.id } : {}),
          environment: activeEnv?.name,
          headers: plan.headers,
          body: describeBody(plan.body),
          bodyKind: plan.body?.kind,
          ...(validation
            ? history.checkFields(validation, {
                version: linked!.spec.version,
                fingerprint: history.fingerprint(linked!.spec.sourceText),
              })
            : { validation: "no_schema" as const }),
          mock: toMock,
          statusText: response.statusText,
          responseHeaders: response.headers,
          responseBody: storedResponseBody(response),
          runId,
          collection: { id: collection.id, name: collection.name, step: step.key, index, total, passed: verdict === "pass" },
        });
        return {
          key: step.key,
          verdict,
          ...(reason ? { reason } : {}),
          status: response.status,
          ms: response.ms,
          ...(validation ? { validation } : {}),
          output,
          request: plan,
          mock: toMock,
          ...(warned.length ? { mockWarnings: warned } : {}),
        };
      };

      const results = await runSteps(collection.steps, execute, {
        stopOnFailure: collection.stopOnFailure,
        cancelled: () => cancelled.current.has(id),
        onResult: (partial) =>
          setRuns((prev) => ({ ...prev, [id]: { runId, at, running: true, results: partial } })),
        run: { collection: logged.collection, environment: logged.environment, targets },
        describe: (_step, index) => described[index],
        onEvent: (event) => runLogs.onEvent(logged, event),
      });
      setRuns((prev) => ({ ...prev, [id]: { runId, at, running: false, results } }));
      const summary = summariseRun(results);
      logToConsole({
        source: "collection",
        level: summary.failed ? "error" : "info",
        run: { collectionId: collection.id, runId },
        text: `Run finished: ${collection.name} · ${describeRun(summary)}`,
      });
      setRequests(await history.loadHistory());
    },
    [runs, ensureSpecs, entries, mockUrlFor, session, tokenFor, vars, connection, activeEnv, setRequests, localMocks.running, runLogs.onEvent],
  );

  const stop = useCallback((id: string) => {
    cancelled.current.add(id);
  }, []);

  // ── adding from elsewhere in the app ───────────────────────────────────────

  const [addMenu, setAddMenu] = useState<AddMenuState | null>(null);
  const [added, setAdded] = useState<AddedNote | null>(null);

  /** After adding: a new collection opens (it wants a name); an existing one says where the step went. */
  const afterAdd = useCallback(
    (collection: Collection | null, isNew: boolean, what: string) => {
      if (!collection) return;
      if (isNew) {
        setSelectedId(collection.id);
        setSelectedStep(Math.max(0, collection.steps.length - 1));
        showCollections();
      } else {
        setAdded({ text: `Added ${what} to ${collection.name}`, collectionId: collection.id });
      }
    },
    [showCollections],
  );

  /**
   * Right-click on an operation. The operation on screen is added with what's in
   * its editor and the address it's aimed at; any other starts from its schema.
   */
  const openOperationMenu = useCallback(
    (
      position: { x: number; y: number },
      context: {
        entry: LibraryEntry;
        spec: ParsedSpec;
        op: OperationSpec;
        editor?: { values: RequestValues; address: string; mockUrl: string | null; auth: AuthState | null } | null;
      },
    ) => {
      const { entry, spec, op, editor } = context;
      const what = op.operationId ?? `${op.method} ${op.path}`;
      setAddMenu({
        ...position,
        what,
        onAdd: (collectionId) => {
          const values = editor ? inputsFromEditor(op, editor.values) : undefined;
          const target = editor ? targetFromAddress(editor.address, spec, editor.mockUrl) : undefined;
          const auth = editor ? stepAuthOf(editor.auth) : undefined;
          afterAdd(addOperation(collectionId, entry, spec, op, values, target, auth), !collectionId, what);
        },
      });
    },
    [addOperation, afterAdd],
  );

  /** "Add to a collection" on a recorded request, keeping the values it was sent with. */
  const openRecordMenu = useCallback(
    (position: { x: number; y: number }, record: HistoryEntry, spec: ParsedSpec | null) => {
      const what = `${record.method} ${record.path}`;
      setAddMenu({
        ...position,
        what,
        onAdd: (collectionId) => afterAdd(addRecorded(collectionId, record, spec), !collectionId, what),
      });
    },
    [addRecorded, afterAdd],
  );

  /**
   * Add an API a collection refers to, by its file or URL, without leaving the
   * collection. The button that calls this names the file or URL, so reading
   * it is the user's choice.
   */
  const addApiToLibrary = useCallback(
    async (source: LibraryEntry["source"], title: string, collectionId: string) => {
      try {
        let text: string;
        if (source.kind === "file") {
          const read = await readCollectionFile(source.ref);
          if (read === null) throw new Error(`Can't read ${source.ref}.`);
          text = read;
        } else if (source.kind === "url") {
          const response = await appFetch(source.ref);
          if (!response.ok) throw new Error(`${source.ref} answered ${response.status}.`);
          text = await response.text();
        } else return;
        const parsed = parseSpec(text, title, documentUrlOf(source));
        await library.addToLibrary({
          title: parsed.title || title,
          version: parsed.version,
          source,
          text,
          operations: parsed.operations.length,
          schemas: parsed.schemas.length,
        });
        setEntries(await library.loadLibrary());
      } catch (error) {
        notify(collectionId, {
          kind: "error",
          text: `Couldn't add ${title}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    },
    [setEntries, notify],
  );

  return {
    loaded,
    collections,
    selected,
    selectedId,
    select: useCallback((id: string) => {
      setSelectedId(id);
      setSelectedStep(0);
    }, []),
    selectedStep,
    setSelectedStep,
    links,
    specs,
    specForEntry,
    revision,
    runs,
    notices,
    notify,
    conflicts,
    openError,
    setOpenError,
    create: useCallback(() => create(freshName()), [create, freshName]),
    remove,
    rename,
    setStopOnFailure,
    updateStep,
    renameStepKey,
    moveStep,
    removeStep,
    relinkStep,
    addOperation,
    addRecorded,
    run,
    stop,
    save,
    saveToFolder,
    exportCollection,
    stopLinking,
    resolveConflict,
    openFromFile,
    addFromText,
    importText,
    imported,
    finishImport,
    mockUrlFor,
    localMocks,
    addMenu,
    closeAddMenu: useCallback(() => setAddMenu(null), []),
    openOperationMenu,
    openRecordMenu,
    added,
    dismissAdded: useCallback(() => setAdded(null), []),
    addApiToLibrary,
    runLogs,
  };
}

export type CollectionsApi = ReturnType<typeof useCollections>;
