import { editorFingerprint, type EditorState } from "./editor";
import { redact, redactHeaders } from "./redact";
import type { AuthState } from "./request";

/**
 * Unsent changes: what you typed into an operation and haven't sent yet.
 *
 * Each operation of each API keeps its own draft, so moving to another
 * operation, another API or another tab and back finds the fields as you left
 * them. The rules:
 *
 * - A draft is "changed" (the dot in the sidebar and on the tab) when its fields
 *   differ from what was last sent from that editor, or from the spec's
 *   examples if nothing has been sent from it.
 * - A successful send (any response came back, whatever its status) makes the
 *   sent values the new starting point: the dot goes away, and the operation
 *   reopens with those values, including after a restart.
 * - Discard goes back to the spec's examples and forgets the draft, the last
 *   sent values included. What was sent is still in History.
 *
 * Drafts are written to `drafts.json` with secret values swapped for their
 * `{{references}}`, the same as history and collections. Auth is kept per API,
 * as the editor treats it: a value that is a `{{reference}}` is written down,
 * anything else (a token typed straight in) is held in memory only, for this
 * session, and never reaches the file.
 *
 * No React here; the hook is `src/hooks/useDrafts.ts`.
 */

export interface OperationDraft {
  /** The fields as they were left. */
  values: EditorState;
  /** What was last sent from this editor, if anything; the baseline for "changed". */
  sent?: EditorState;
  sentAt?: string;
  /** The fields differ from `sent`, or from the spec's examples when nothing was sent. */
  changed: boolean;
  updatedAt: string;
}

/** The auth an API's editor was left with. `value` is only ever a reference on disk. */
export interface AuthDraft {
  schemeName: string | null;
  type?: string;
  httpScheme?: string;
  in?: string;
  paramName?: string;
  value: string;
}

export interface DraftFile {
  version: 1;
  /** Keyed by {@link draftKey}. */
  operations: Record<string, OperationDraft>;
  /** Keyed by library entry id. */
  auth: Record<string, AuthDraft>;
}

export const EMPTY_DRAFTS: DraftFile = { version: 1, operations: {}, auth: {} };

/** One operation of one API. Operation ids are `METHOD /path`, and API ids have no spaces. */
export function draftKey(apiId: string, operationId: string): string {
  return `${apiId} ${operationId}`;
}

function apiOf(key: string): string {
  return key.slice(0, key.indexOf(" "));
}

/**
 * The editor changed. `seed` is what the spec's examples would fill it with,
 * the baseline when nothing has been sent.
 *
 * An operation left exactly as the spec suggests, with nothing sent, has no
 * draft at all, so the file only lists operations someone actually touched.
 */
export function recordEdit(
  file: DraftFile,
  key: string,
  values: EditorState,
  seed: EditorState,
  now: string,
): DraftFile {
  const existing = file.operations[key];
  const baseline = existing?.sent ?? seed;
  const changed = editorFingerprint(values) !== editorFingerprint(baseline);
  if (!changed && !existing?.sent) {
    if (!existing) return file;
    return discardDraft(file, key);
  }
  if (existing && existing.changed === changed && editorFingerprint(existing.values) === editorFingerprint(values)) {
    return file;
  }
  return {
    ...file,
    operations: { ...file.operations, [key]: { ...existing, values, changed, updatedAt: now } },
  };
}

/** A send got a response: what was sent becomes the new starting point. */
export function recordSent(file: DraftFile, key: string, sent: EditorState, now: string): DraftFile {
  const existing = file.operations[key];
  // If the fields moved on while the request was out, they are still unsent changes.
  const values = existing?.values ?? sent;
  const changed = editorFingerprint(values) !== editorFingerprint(sent);
  return {
    ...file,
    operations: {
      ...file.operations,
      [key]: { values, sent, sentAt: now, changed, updatedAt: now },
    },
  };
}

/** Back to the spec's examples: the draft, and what was last sent, are forgotten. */
export function discardDraft(file: DraftFile, key: string): DraftFile {
  if (!(key in file.operations)) return file;
  const operations = { ...file.operations };
  delete operations[key];
  return { ...file, operations };
}

/** The fields to reopen an operation with, or null to start from the spec. */
export function restoreDraft(file: DraftFile, key: string): EditorState | null {
  return file.operations[key]?.values ?? null;
}

export function hasUnsent(file: DraftFile, key: string): boolean {
  return Boolean(file.operations[key]?.changed);
}

/** The operations of one API that have unsent changes, by operation id. */
export function unsentIn(file: DraftFile, apiId: string): Set<string> {
  const prefix = `${apiId} `;
  const ids = new Set<string>();
  for (const [key, draft] of Object.entries(file.operations)) {
    if (draft.changed && key.startsWith(prefix)) ids.add(key.slice(prefix.length));
  }
  return ids;
}

/** An API was removed from the library: its drafts go with it. */
export function forgetApi(file: DraftFile, apiId: string): DraftFile {
  const operations = Object.fromEntries(Object.entries(file.operations).filter(([key]) => apiOf(key) !== apiId));
  const auth = { ...file.auth };
  delete auth[apiId];
  return { ...file, operations, auth };
}

// ── auth ──────────────────────────────────────────────────────────────────────

const REFERENCE = /\{\{\s*[\w.-]+\s*\}\}/;

export function authDraftOf(auth: AuthState | null): AuthDraft {
  if (!auth) return { schemeName: null, value: "" };
  return {
    schemeName: auth.schemeName,
    ...(auth.type ? { type: auth.type } : {}),
    ...(auth.httpScheme ? { httpScheme: auth.httpScheme } : {}),
    ...(auth.in ? { in: auth.in } : {}),
    ...(auth.paramName ? { paramName: auth.paramName } : {}),
    value: auth.value,
  };
}

/** The editor's auth from a draft. OAuth values are never kept: the token comes from the cache. */
export function authFromDraft(draft: AuthDraft): AuthState | null {
  if (!draft.schemeName) return { schemeName: null, value: "" };
  return {
    schemeName: draft.schemeName,
    value: draft.type === "oauth2" ? "" : draft.value,
    ...(draft.type ? { type: draft.type } : {}),
    ...(draft.httpScheme ? { httpScheme: draft.httpScheme } : {}),
    ...(draft.in ? { in: draft.in } : {}),
    ...(draft.paramName ? { paramName: draft.paramName } : {}),
  };
}

/**
 * Whether a remembered auth still fits the spec: a declared scheme must still
 * be declared. Studio's own choices (bearer, basic, a header, OAuth) always fit.
 */
export function authFits(auth: AuthState | null, schemeNames: readonly string[]): boolean {
  if (!auth?.schemeName) return true;
  return auth.schemeName.startsWith("__") || schemeNames.includes(auth.schemeName);
}

export function setAuthDraft(file: DraftFile, apiId: string, auth: AuthState | null): DraftFile {
  const next = authDraftOf(auth);
  const existing = file.auth[apiId];
  if (existing && JSON.stringify(existing) === JSON.stringify(next)) return file;
  return { ...file, auth: { ...file.auth, [apiId]: next } };
}

// ── on disk ───────────────────────────────────────────────────────────────────

function redactValues(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, redact(v)]));
}

function redactEditor(state: EditorState): EditorState {
  return {
    pathParams: redactValues(state.pathParams),
    queryParams: redactValues(state.queryParams),
    headerParams: redactHeaders(state.headerParams),
    body: redact(state.body),
    formFields: state.formFields.map((f) => ({ key: f.key, value: redact(f.value) })),
    parts: state.parts.map((p) => (p.value === undefined ? p : { ...p, value: redact(p.value) })),
    custom: state.custom.map((row) => ({ key: row.key, value: redactHeaders({ [row.key]: row.value })[row.key] })),
  };
}

/**
 * The file as written: known secret values become their `{{references}}`, and
 * an auth value that isn't a reference is left out.
 */
export function redactDrafts(file: DraftFile): DraftFile {
  const operations = Object.fromEntries(
    Object.entries(file.operations).map(([key, draft]) => [
      key,
      {
        ...draft,
        values: redactEditor(draft.values),
        ...(draft.sent ? { sent: redactEditor(draft.sent) } : {}),
      },
    ]),
  );
  const auth = Object.fromEntries(
    Object.entries(file.auth).map(([apiId, draft]) => {
      const value = redact(draft.value);
      return [apiId, { ...draft, value: value && REFERENCE.test(value) ? value : "" }];
    }),
  );
  return { version: 1, operations, auth };
}

function isEditorState(value: unknown): value is EditorState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<EditorState>;
  return (
    typeof state.pathParams === "object" &&
    typeof state.queryParams === "object" &&
    typeof state.headerParams === "object" &&
    typeof state.body === "string" &&
    Array.isArray(state.formFields) &&
    Array.isArray(state.parts) &&
    Array.isArray(state.custom)
  );
}

/** Read what was stored, dropping anything that doesn't look like a draft rather than failing. */
export function parseDrafts(raw: unknown): DraftFile {
  if (!raw || typeof raw !== "object") return EMPTY_DRAFTS;
  const stored = raw as Partial<DraftFile>;
  if (stored.version !== 1) return EMPTY_DRAFTS;
  const operations: Record<string, OperationDraft> = {};
  for (const [key, draft] of Object.entries(stored.operations ?? {})) {
    if (!key.includes(" ") || !draft || !isEditorState(draft.values)) continue;
    operations[key] = {
      values: draft.values,
      ...(isEditorState(draft.sent) ? { sent: draft.sent } : {}),
      ...(typeof draft.sentAt === "string" ? { sentAt: draft.sentAt } : {}),
      changed: Boolean(draft.changed),
      updatedAt: typeof draft.updatedAt === "string" ? draft.updatedAt : "",
    };
  }
  const auth: Record<string, AuthDraft> = {};
  for (const [apiId, draft] of Object.entries(stored.auth ?? {})) {
    if (draft && typeof draft === "object" && typeof draft.value === "string") auth[apiId] = draft;
  }
  return { version: 1, operations, auth };
}

/** The editor at the moment a request went out, handed back when its answer arrives. */
export interface SendSnapshot {
  key: string;
  values: EditorState;
  fingerprint: string;
}
