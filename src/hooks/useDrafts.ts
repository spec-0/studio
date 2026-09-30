import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  authFromDraft,
  discardDraft,
  draftKey,
  EMPTY_DRAFTS,
  forgetApi as forgetApiDrafts,
  hasUnsent as hasUnsentIn,
  parseDrafts,
  recordEdit,
  recordSent,
  redactDrafts,
  restoreDraft,
  setAuthDraft,
  unsentIn,
  type DraftFile,
  type SendSnapshot,
} from "../lib/drafts";
import { editorFingerprint, seedEditor, type EditorState } from "../lib/editor";
import type { AuthState } from "../lib/request";
import type { OperationSpec, ParsedSpec } from "../lib/spec";
import { readStore, writeStore, STORE } from "../lib/store";

/** How long typing has to pause before the drafts file is written. */
const WRITE_DELAY_MS = 400;

/**
 * Unsent changes in the operation editor, kept per API and operation (the
 * rules are in `src/lib/drafts.ts`).
 *
 * The drafts live in a ref, so typing doesn't re-render the whole window; the
 * screen is only redrawn when an operation gains or loses its "unsent changes"
 * dot, or a draft is sent or discarded.
 */
export function useDrafts({
  apiId,
  spec,
  operation,
  prefilled,
}: {
  apiId: string | undefined;
  spec: ParsedSpec | null;
  operation: OperationSpec | null;
  /** The editor was filled from a recording; that wins over a draft. */
  prefilled: boolean;
}) {
  const file = useRef<DraftFile>(EMPTY_DRAFTS);
  /** Bumped whenever something on screen depends on the drafts. */
  const [version, setVersion] = useState(0);
  /** Bumped to reopen the editor from scratch, after Discard. */
  const [revision, setRevision] = useState(0);
  /** Typed auth values, for this session only. Only references reach the file. */
  const authMemory = useRef(new Map<string, AuthState | null>());

  const key = apiId && operation ? draftKey(apiId, operation.id) : null;
  const seed = useMemo(
    () => (spec && operation ? seedEditor(spec, operation, null, false) : null),
    [spec, operation],
  );
  const current = useRef<{ key: string | null; seed: EditorState | null; values: EditorState | null }>({
    key: null,
    seed: null,
    values: null,
  });
  if (current.current.key !== key || current.current.seed !== seed) {
    current.current = { key, seed, values: null };
  }

  // ── on disk ──────────────────────────────────────────────────────────────────

  const writeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useCallback(() => {
    if (writeTimer.current) clearTimeout(writeTimer.current);
    writeTimer.current = null;
    void writeStore(STORE.drafts, redactDrafts(file.current));
  }, []);
  const scheduleWrite = useCallback(() => {
    if (writeTimer.current) clearTimeout(writeTimer.current);
    writeTimer.current = setTimeout(flush, WRITE_DELAY_MS);
  }, [flush]);

  useEffect(() => {
    let cancelled = false;
    void readStore<unknown>(STORE.drafts, null).then((raw) => {
      if (cancelled) return;
      const stored = parseDrafts(raw);
      // Anything recorded while the file was loading wins over what it held.
      file.current = {
        version: 1,
        operations: { ...stored.operations, ...file.current.operations },
        auth: { ...stored.auth, ...file.current.auth },
      };
      setVersion((v) => v + 1);
    });
    const onHide = () => {
      if (writeTimer.current) flush();
    };
    window.addEventListener("pagehide", onHide);
    return () => {
      cancelled = true;
      window.removeEventListener("pagehide", onHide);
    };
  }, [flush]);

  const update = useCallback(
    (next: DraftFile, redraw: boolean) => {
      if (next === file.current) return;
      file.current = next;
      scheduleWrite();
      if (redraw) setVersion((v) => v + 1);
    },
    [scheduleWrite],
  );

  // ── the editor ───────────────────────────────────────────────────────────────

  /** Remounts the editor for another operation, or after Discard. */
  const editorKey = `${key ?? ""}:${revision}`;

  /** What the editor opens with: the draft if there is one, unless it was filled from a recording. */
  const draft = useMemo(
    () => (key && !prefilled ? restoreDraft(file.current, key) : null),
    // Only when another operation opens, the spec is read again, or after
    // Discard; re-reading on every keystroke would fight the editor for its own
    // fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editorKey, prefilled, spec, operation],
  );

  const onEditorChange = useCallback(
    (values: EditorState) => {
      const { key: at, seed: from } = current.current;
      if (!at || !from) return;
      current.current.values = values;
      const before = hasUnsentIn(file.current, at);
      const next = recordEdit(file.current, at, values, from, new Date().toISOString());
      update(next, hasUnsentIn(next, at) !== before);
    },
    [update],
  );

  /** The editor as a request goes out. */
  const snapshot = useCallback((): SendSnapshot | null => {
    const { key: at, values } = current.current;
    if (!at || !values) return null;
    return { key: at, values, fingerprint: editorFingerprint(values) };
  }, []);

  /** An answer came back: what was sent is the new starting point. */
  const onSent = useCallback(
    (sent: SendSnapshot) => {
      update(recordSent(file.current, sent.key, sent.values, new Date().toISOString()), true);
    },
    [update],
  );

  /** Back to the spec's examples, for the operation on screen. */
  const discard = useCallback(() => {
    if (!key) return;
    update(discardDraft(file.current, key), true);
    setRevision((r) => r + 1);
  }, [key, update]);

  /** Whether what's on screen differs from what `fingerprint` describes. */
  const editedSince = useCallback((fingerprint: string | null) => {
    const values = current.current.values;
    return Boolean(fingerprint && values && editorFingerprint(values) !== fingerprint);
  }, []);

  // ── markers ──────────────────────────────────────────────────────────────────

  const unsentOperations = useMemo(
    () => (apiId ? unsentIn(file.current, apiId) : new Set<string>()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [apiId, version],
  );
  const hasUnsent = useCallback(
    (at: string) => hasUnsentIn(file.current, at),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  );

  // ── auth, per API ────────────────────────────────────────────────────────────

  /** The auth an API was left with: this session's, else a reference from the file. */
  const authFor = useCallback((id: string): AuthState | null | undefined => {
    if (authMemory.current.has(id)) return authMemory.current.get(id);
    const stored = file.current.auth[id];
    return stored ? authFromDraft(stored) : undefined;
  }, []);

  const rememberAuth = useCallback(
    (id: string, auth: AuthState | null) => {
      authMemory.current.set(id, auth);
      update(setAuthDraft(file.current, id, auth), false);
    },
    [update],
  );

  /** An API left the library. */
  const forgetApi = useCallback(
    (id: string) => {
      authMemory.current.delete(id);
      update(forgetApiDrafts(file.current, id), true);
    },
    [update],
  );

  return {
    editorKey,
    draft,
    onEditorChange,
    snapshot,
    onSent,
    discard,
    editedSince,
    /** The operation on screen has unsent changes. */
    unsent: key ? hasUnsentIn(file.current, key) : false,
    unsentOperations,
    hasUnsent,
    authFor,
    rememberAuth,
    forgetApi,
  };
}
