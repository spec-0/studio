import { readStore, writeStore, STORE } from "./store";

/**
 * Request history — local only, never synced. Recorded so a request can be found
 * again and replayed. This stays on the machine, always.
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
  /** `METHOD /path`, so the entry can be matched back to an operation on replay. */
  operationId: string;
  headers: Record<string, string>;
  /**
   * A readable rendering of what was sent.
   *
   * For a text body that's the body itself. For a form or multipart request it's
   * a summary — file *contents* are not recorded, so a replay restores the shape
   * and asks for the file again rather than pretending it still has it.
   */
  body?: string;
  /** Which kind of body it was, so replay knows whether `body` can be restored. */
  bodyKind?: "text" | "form" | "multipart";
  validation?: "ok" | "mismatch" | "no_schema" | "error";
  /** Hit a mock rather than the real server. */
  mock?: boolean;
  /**
   * The conformance run this request belonged to.
   *
   * Recorded so a run's requests are findable afterwards — a bulk run that left
   * 40 indistinguishable rows in history would make the log worse, not better.
   */
  runId?: string;
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

export async function record(entry: Omit<HistoryEntry, "id" | "at">): Promise<HistoryEntry[]> {
  const existing = await loadHistory();
  const body =
    entry.responseBody && entry.responseBody.length > MAX_STORED_BODY
      ? `${entry.responseBody.slice(0, MAX_STORED_BODY)}\n\n… truncated for history`
      : entry.responseBody;
  const next: HistoryEntry[] = [
    {
      ...entry,
      responseBody: body,
      id: `req_${Date.now().toString(36)}`,
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
 * History stores the URL that went out, not the values that built it, so
 * replaying an entry used to restore headers and body but leave every path and
 * query field empty — `GET /accounts/{accountId}` came back with a blank
 * `accountId` sitting next to the 200 it returned, which reads as a bug in the
 * app rather than a gap in what was recorded.
 *
 * The operation's path template is matched against the end of the recorded
 * path, so a server with its own base path (`https://api.example.com/v1`) lines
 * up correctly. If the literal segments don't agree the template isn't the one
 * that produced this URL, and path values are left empty rather than guessed —
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
