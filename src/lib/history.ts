import { readStore, writeStore, STORE } from "./store";
import { redact, redactHeaders } from "./redact";
import { declaredResponse } from "./response";
import { SCRATCH_OPERATION_ID } from "./scratch";
import type { ParsedSpec } from "./spec";
import { validateResponse, type Finding, type ValidationResult } from "./validate";

/**
 * Request history: local only, never synced. A log of what was sent and what
 * came back, read in its own view. An entry is never loaded back into the
 * request editors as if it were live; running it again means copying it into a
 * new request, on purpose. This stays on the machine, always.
 */

export interface HistoryEntry {
  id: string;
  at: string;
  method: string;
  path: string;
  url: string;
  status: number;
  ms: number;
  bytes: number;
  specTitle: string;
  /** `METHOD /path`, so the entry can be matched back to an operation. */
  operationId: string;
  /**
   * The library entry this request belonged to. Newer entries only; older ones
   * are matched to their API by `specTitle`.
   */
  apiId?: string;
  /** Name of the environment that was active when it ran, if any. */
  environment?: string;
  headers: Record<string, string>;
  /**
   * A readable rendering of what was sent.
   *
   * For a text body that's the body itself. For a form or multipart request it's
   * a summary. File *contents* are not recorded, so copying it into a new
   * request restores the shape and asks for the file again rather than
   * pretending it still has it.
   */
  body?: string;
  /** Which kind of body it was, so a copy knows whether `body` can be restored. */
  bodyKind?: "text" | "form" | "multipart";
  /** The check verdict at the time it ran. */
  validation?: "ok" | "mismatch" | "no_schema" | "error";
  /**
   * What the check found at the time it ran, capped. Stored rather than
   * recomputed so the log says what happened then; re-checking against a spec
   * that has since changed answers a different question. Older entries have
   * only the verdict.
   */
  findings?: Finding[];
  /** The check's explanation when there was no verdict (no schema, not JSON). */
  checkNote?: string;
  /** `info.version` of the spec the check ran against. */
  specVersion?: string;
  /** A hash of the spec text the check ran against, to tell if it has changed. */
  specFingerprint?: string;
  /** Hit a mock rather than the real server. */
  mock?: boolean;
  /**
   * The conformance run this request belonged to.
   *
   * Recorded so a run's requests are findable afterwards: a bulk run that left
   * 40 indistinguishable rows in history would make the log worse, not better.
   */
  runId?: string;
  /**
   * Set when the request was a step of a collection run. History shows the run
   * as one row, with its steps inside it.
   */
  collection?: {
    id: string;
    name: string;
    /** The step's key. */
    step: string;
    /** Position in the collection, from 0, and how many steps it has. */
    index: number;
    total: number;
    passed: boolean;
  };
  statusText?: string;
  responseHeaders?: Record<string, string>;
  /**
   * The response body as received, capped. Without it a history entry can say a
   * call happened but not what came back, which makes the list a log rather than
   * something you can actually return to.
   */
  responseBody?: string;
}

/** Bodies are capped so a few large responses can't bloat the history file. */
export const MAX_STORED_BODY = 256 * 1024;

export const DEFAULT_RETENTION_DAYS = 30;

export async function loadHistory(): Promise<HistoryEntry[]> {
  return prune(await readStore<HistoryEntry[]>(STORE.history, []));
}

/**
 * Replace secret values with their `{{name}}` references, everywhere a request
 * or its response could carry one: the URL (an API key in the query), headers
 * (a bearer token, a Basic credential), and both bodies (a server that echoes
 * what it was sent).
 */
export function redactEntry<T extends Omit<HistoryEntry, "id" | "at">>(entry: T): T {
  return {
    ...entry,
    // A finding can quote a field from the response; a server that echoes a
    // token back would otherwise put it in the log through the check result.
    ...(entry.findings
      ? {
          findings: entry.findings.map((f) => ({
            ...f,
            path: redact(f.path),
            message: redact(f.message),
          })),
        }
      : {}),
    ...(entry.checkNote !== undefined ? { checkNote: redact(entry.checkNote) } : {}),
    url: redact(entry.url),
    path: redact(entry.path),
    headers: redactHeaders(entry.headers),
    body: redact(entry.body),
    responseHeaders: redactHeaders(entry.responseHeaders),
    responseBody: redact(entry.responseBody),
  } as T;
}

/**
 * Remove secret values from history written before redaction existed.
 *
 * Entries from older versions hold the headers as sent, bearer token included.
 * Runs at start-up once the secrets are known, and rewrites the file only if something
 * changed.
 */
export async function scrubHistory(): Promise<void> {
  const stored = await readStore<HistoryEntry[]>(STORE.history, []);
  const scrubbed = stored.map((entry) => redactEntry(entry));
  if (JSON.stringify(scrubbed) !== JSON.stringify(stored)) await writeStore(STORE.history, scrubbed);
}

export async function record(raw: Omit<HistoryEntry, "id" | "at">): Promise<HistoryEntry[]> {
  const existing = await loadHistory();
  const entry = redactEntry(raw);
  const body =
    entry.responseBody && entry.responseBody.length > MAX_STORED_BODY
      ? `${entry.responseBody.slice(0, MAX_STORED_BODY)}\n\n… truncated for history`
      : entry.responseBody;
  const next: HistoryEntry[] = [
    {
      ...entry,
      responseBody: body,
      // A bulk run records several requests in the same millisecond; the random
      // tail keeps ids unique so selecting one entry never selects another.
      id: `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      at: new Date().toISOString(),
    },
    ...existing,
  ].slice(0, 200);
  await writeStore(STORE.history, next);
  return next;
}

export async function clearHistory(): Promise<void> {
  await writeStore(STORE.history, []);
}

function prune(entries: HistoryEntry[], days = DEFAULT_RETENTION_DAYS): HistoryEntry[] {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return entries.filter((entry) => {
    const at = Date.parse(entry.at);
    return Number.isNaN(at) || at >= cutoff;
  });
}

export function search(entries: HistoryEntry[], query: string): HistoryEntry[] {
  if (!query.trim()) return entries;
  const needle = query.toLowerCase();
  return entries.filter((entry) =>
    `${entry.method} ${entry.path} ${entry.url} ${entry.status} ${entry.specTitle}`
      .toLowerCase()
      .includes(needle),
  );
}

export function relativeTime(iso: string): string {
  const delta = Date.now() - Date.parse(iso);
  if (Number.isNaN(delta)) return "";
  const minutes = Math.round(delta / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Recover the parameter values a recorded request was sent with.
 *
 * History stores the URL that went out, not the values that built it. Without
 * this, a copied `GET /accounts/{accountId}` would show a blank `accountId` next
 * to the 200 it returned, which reads as a bug in the app rather than a gap in
 * what was recorded.
 *
 * The operation's path template is matched against the end of the recorded
 * path, so a server with its own base path (`https://api.example.com/v1`) lines
 * up correctly. If the literal segments don't agree the template isn't the one
 * that produced this URL, and path values are left empty rather than guessed:
 * a wrong value silently placed in a field is worse than an empty one. Query
 * parameters are unambiguous, so they are returned either way.
 */
export function paramsFromEntry(
  entry: Pick<HistoryEntry, "url">,
  pathTemplate: string,
): { pathParams: Record<string, string>; queryParams: Record<string, string> } {
  const queryParams: Record<string, string> = {};
  let url: URL;
  try {
    url = new URL(entry.url);
  } catch {
    return { pathParams: {}, queryParams };
  }
  for (const [key, value] of url.searchParams) queryParams[key] = value;

  const template = pathTemplate.split("/").filter(Boolean);
  const actual = url.pathname.split("/").filter(Boolean);
  if (template.length === 0 || actual.length < template.length) {
    return { pathParams: {}, queryParams };
  }

  // The template is the tail of the path; anything before it is the base path.
  const offset = actual.length - template.length;
  const pathParams: Record<string, string> = {};
  for (let i = 0; i < template.length; i += 1) {
    const segment = template[i];
    const got = actual[offset + i];
    const placeholder = /^\{(.+)\}$/.exec(segment);
    if (placeholder) {
      try {
        pathParams[placeholder[1]] = decodeURIComponent(got);
      } catch {
        pathParams[placeholder[1]] = got;
      }
    } else if (segment !== got) {
      return { pathParams: {}, queryParams };
    }
  }
  return { pathParams, queryParams };
}

// What was recorded, and reading it back

/** Findings stored per entry. The validator already caps at 40; this is the file's own bound. */
export const MAX_STORED_FINDINGS = 40;
const MAX_FINDING_TEXT = 300;

/**
 * The check-result fields to store with a request, from the check that just ran.
 *
 * Spread into `record(...)` so every place that sends stores the same thing.
 */
export function checkFields(
  result: ValidationResult,
  spec?: { version?: string; fingerprint?: string },
): Pick<HistoryEntry, "validation" | "findings" | "checkNote" | "specVersion" | "specFingerprint"> {
  const clip = (text: string) =>
    text.length > MAX_FINDING_TEXT ? `${text.slice(0, MAX_FINDING_TEXT - 1)}…` : text;
  return {
    validation: result.status,
    findings: result.findings.slice(0, MAX_STORED_FINDINGS).map((f) => ({
      kind: f.kind,
      path: clip(f.path),
      message: clip(f.message),
    })),
    ...(result.note ? { checkNote: clip(result.note) } : {}),
    ...(spec?.version ? { specVersion: spec.version } : {}),
    ...(spec?.fingerprint ? { specFingerprint: spec.fingerprint } : {}),
  };
}

/**
 * A short, stable hash of a spec's text (cyrb53).
 *
 * Only used to answer "is this the same document the check ran against?" It is not
 * a security boundary, so a fast non-cryptographic hash is the right tool. It
 * runs once per loaded spec, not per request.
 */
export function fingerprint(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * The check result as recorded, or null if the entry has none.
 *
 * `findings` is undefined for entries recorded before findings were stored:
 * the verdict is known, the detail isn't, and the view says so rather than
 * showing an empty list that would read as "nothing found".
 */
export function recordedCheck(
  entry: Pick<HistoryEntry, "validation" | "findings" | "checkNote">,
): { status: ValidationResult["status"]; findings?: Finding[]; note?: string } | null {
  if (!entry.validation) return null;
  return { status: entry.validation, findings: entry.findings, note: entry.checkNote };
}

/**
 * Has the spec changed since this entry's check ran?
 *
 * "unknown" when the entry predates fingerprints; guessing either way would
 * misstate how much the recorded result can be trusted.
 */
export function specChange(
  entry: Pick<HistoryEntry, "specFingerprint" | "specVersion">,
  current: { fingerprint?: string; version?: string } | null,
): "same" | "changed" | "unknown" {
  if (!current) return "unknown";
  if (entry.specFingerprint && current.fingerprint) {
    return entry.specFingerprint === current.fingerprint ? "same" : "changed";
  }
  // A different version is a fact even without a fingerprint; the same version
  // is not proof of the same document, so it stays unknown.
  if (entry.specVersion && current.version && entry.specVersion !== current.version) {
    return "changed";
  }
  return "unknown";
}

/** The recorded body parsed as JSON, or undefined if it isn't JSON. */
function parsedBody(text: string | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Check a recorded response against a spec, normally the current one.
 *
 * Null when it can't be checked at all: a scratch request, an operation the
 * spec no longer has, or an entry recorded before responses were stored. Uses
 * the same status lookup as a live send, so the two can't disagree.
 */
export function recheck(entry: HistoryEntry, spec: ParsedSpec): ValidationResult | null {
  if (isScratch(entry) || entry.responseBody === undefined) return null;
  const op = spec.operations.find((o) => o.id === entry.operationId);
  if (!op) return null;
  const declared = declaredResponse(op.responses, entry.status);
  return validateResponse(spec.doc, declared?.schema, parsedBody(entry.responseBody));
}

export function isScratch(entry: Pick<HistoryEntry, "operationId">): boolean {
  return entry.operationId === SCRATCH_OPERATION_ID;
}

// The list: which API, and filters

/** Key identifying the API an entry belongs to: its library id, or its title for older entries. */
export function apiKey(entry: Pick<HistoryEntry, "apiId" | "specTitle" | "operationId">): string {
  if (isScratch(entry)) return SCRATCH_OPERATION_ID;
  return entry.apiId ? `id:${entry.apiId}` : `title:${entry.specTitle}`;
}

/**
 * Does this entry belong to the given API?
 *
 * Newer entries carry the library id. Older ones only have the spec title, so
 * those match on title, the best that was recorded.
 */
export function belongsTo(
  entry: Pick<HistoryEntry, "apiId" | "specTitle" | "operationId">,
  api: { id: string; title: string },
): boolean {
  if (isScratch(entry)) return false;
  return entry.apiId ? entry.apiId === api.id : entry.specTitle === api.title;
}

/**
 * Give older entries their API's library id, in memory only.
 *
 * Entries written before the id was recorded carry only a spec title. Where
 * exactly one API in the library has that title the match is unambiguous, so
 * the entry is treated as belonging to it; otherwise one API would show up
 * twice in the filter. Ambiguous or unmatched titles are left alone; guessing
 * would file a request under the wrong API.
 */
export function attachApiIds(
  entries: HistoryEntry[],
  apis: ReadonlyArray<{ id: string; title: string }>,
): HistoryEntry[] {
  const byTitle = new Map<string, string | null>();
  for (const api of apis) byTitle.set(api.title, byTitle.has(api.title) ? null : api.id);
  let changed = false;
  const out = entries.map((entry) => {
    if (entry.apiId || isScratch(entry)) return entry;
    const id = byTitle.get(entry.specTitle);
    if (!id) return entry;
    changed = true;
    return { ...entry, apiId: id };
  });
  return changed ? out : entries;
}

/** Each API that appears in history, for the filter: newest first, scratch last. */
export function apiChoices(
  entries: HistoryEntry[],
): Array<{ key: string; label: string; count: number }> {
  const seen = new Map<string, { key: string; label: string; count: number }>();
  for (const entry of entries) {
    const key = apiKey(entry);
    const existing = seen.get(key);
    if (existing) existing.count += 1;
    else seen.set(key, { key, label: entry.specTitle || "Untitled API", count: 1 });
  }
  const list = [...seen.values()];
  return [
    ...list.filter((c) => c.key !== SCRATCH_OPERATION_ID),
    ...list.filter((c) => c.key === SCRATCH_OPERATION_ID),
  ];
}

export type StatusClass = "2xx" | "3xx" | "4xx" | "5xx" | "errors";

export interface HistoryFilter {
  /** An {@link apiKey}, or undefined for every API. */
  api?: string;
  /** "errors" is any 4xx or 5xx. */
  status?: StatusClass;
  /** Only responses whose recorded check found drift. */
  driftOnly?: boolean;
  target?: "mock" | "real";
  query?: string;
}

export function statusMatches(status: number, wanted: StatusClass): boolean {
  if (wanted === "errors") return status >= 400 && status <= 599;
  return Math.floor(status / 100) === Number(wanted[0]);
}

export function filterHistory(entries: HistoryEntry[], filter: HistoryFilter): HistoryEntry[] {
  const narrowed = entries.filter((entry) => {
    if (filter.api && apiKey(entry) !== filter.api) return false;
    if (filter.status && !statusMatches(entry.status, filter.status)) return false;
    if (filter.driftOnly && entry.validation !== "mismatch") return false;
    if (filter.target === "mock" && !entry.mock) return false;
    if (filter.target === "real" && entry.mock) return false;
    return true;
  });
  return search(narrowed, filter.query ?? "");
}

// Copying into a new request

/**
 * Where "Copy to a new request" can put an entry.
 *
 * An operation still in the spec gets the normal editor, pre-filled. A scratch
 * request, or one whose operation is gone, can only go to the scratch pad,
 * which takes any URL; the reason is returned so the view can say it.
 */
export function copyDestination(
  entry: HistoryEntry,
  spec: ParsedSpec | null,
): { kind: "operation" } | { kind: "scratch"; reason?: string } {
  if (isScratch(entry)) return { kind: "scratch" };
  if (!spec) {
    return {
      kind: "scratch",
      reason: "This API isn't in your library any more, so it can only be copied to the scratch pad.",
    };
  }
  if (!spec.operations.some((op) => op.id === entry.operationId)) {
    return {
      kind: "scratch",
      reason: `${entry.operationId} is no longer in this spec, so it can't open as that operation. It can be copied to the scratch pad instead.`,
    };
  }
  return { kind: "operation" };
}

/** The values a new request starts from when copied from an entry. */
export function draftFromEntry(
  entry: HistoryEntry,
  pathTemplate: string,
): {
  server: string | null;
  headers: Record<string, string>;
  body?: string;
  pathParams: Record<string, string>;
  queryParams: Record<string, string>;
} {
  const { pathParams, queryParams } = paramsFromEntry(entry, pathTemplate);
  let server: string | null = null;
  try {
    const parsed = new URL(entry.url);
    // Keep the server's own base path (`/v1`) when the template lines up with
    // the end of the recorded path; otherwise fall back to the origin.
    const template = pathTemplate.split("/").filter(Boolean);
    const actual = parsed.pathname.split("/").filter(Boolean);
    const offset = actual.length - template.length;
    const aligned =
      offset >= 0 && template.every((seg, i) => /^\{.+\}$/.test(seg) || seg === actual[offset + i]);
    const base = aligned && offset > 0 ? `/${actual.slice(0, offset).join("/")}` : "";
    server = `${parsed.protocol}//${parsed.host}${base}`;
  } catch {
    server = null;
  }
  return { server, headers: entry.headers, body: entry.body, pathParams, queryParams };
}

/** "27 Sep 2026, 14:03" in the user's locale: the when, not just how long ago. */
export function absoluteTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
