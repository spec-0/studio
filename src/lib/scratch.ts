import { interpolate } from "./env";
import type { RequestPlan } from "./request";
import { readStore, writeStore, STORE } from "./store";

/**
 * The scratch pad — one ad-hoc request, deliberately bounded.
 *
 * Everything else in Studio starts from a spec, which is the whole point: the
 * schema is what powers body generation, response validation and the graph. But
 * "I have a URL and a body, send it once" is a real step inside that workflow,
 * and today it sends you to curl. This is the escape hatch for that, and nothing
 * more.
 *
 * **The bound is the feature.** There is exactly one pad. It is not named, not
 * saved, not duplicated, and there are no folders — because the first saved
 * ad-hoc request becomes a collection, and a collection is a different product
 * (the product is deliberately locked against it). What persists is the pad's contents, so
 * closing the app doesn't lose what you typed; that is a text buffer, not a
 * saved request. If you want a request kept, described and checked, that is what
 * a spec is for — which is the on-ramp this feature should leave visible rather
 * than replace.
 */

export interface ScratchHeader {
  key: string;
  value: string;
}

export interface ScratchPad {
  method: string;
  url: string;
  headers: ScratchHeader[];
  body: string;
}

export const SCRATCH_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/**
 * How a scratch call is labelled in history.
 *
 * History is a log of what was sent, not an organising primitive, so scratch
 * calls belong in it — but they must be distinguishable, because copying one
 * back out goes to the scratch pad, not to an operation.
 */
export const SCRATCH_TITLE = "Scratch";
export const SCRATCH_OPERATION_ID = "__scratch__";

export const EMPTY_PAD: ScratchPad = {
  method: "GET",
  url: "",
  headers: [],
  body: "",
};

export async function loadScratch(): Promise<ScratchPad> {
  const stored = await readStore<Partial<ScratchPad>>(STORE.scratch, {});
  return {
    method: stored.method ?? EMPTY_PAD.method,
    url: stored.url ?? EMPTY_PAD.url,
    headers: Array.isArray(stored.headers) ? stored.headers : [],
    body: typeof stored.body === "string" ? stored.body : "",
  };
}

export async function saveScratch(pad: ScratchPad): Promise<void> {
  await writeStore(STORE.scratch, pad);
}

/** Methods that carry a body — the same rule the spec-driven path uses. */
export function sendsBody(method: string): boolean {
  return !["GET", "HEAD"].includes(method.toUpperCase());
}

/**
 * Turn the pad into a request.
 *
 * Variables interpolate in the URL, header values and body exactly as they do
 * everywhere else: an environment supplies values, and a scratch request
 * is no more special than any other in that respect.
 *
 * @throws when the URL is empty or doesn't resolve to something sendable — better
 *   a clear message than a fetch that fails obscurely.
 */
export function buildScratchPlan(pad: ScratchPad, vars: Record<string, string> = {}): RequestPlan {
  const fill = (value: string) => interpolate(value, vars);
  const method = pad.method.toUpperCase();

  const url = fill(pad.url).trim();
  if (!url) throw new Error("Enter a URL to send to.");
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`URL must start with http:// or https:// — got "${url}"`);
  }

  const headers: Record<string, string> = {};
  for (const row of pad.headers) {
    const key = row.key.trim();
    if (key && row.value !== "") headers[key] = fill(row.value);
  }

  const body = fill(pad.body);
  const carriesBody = sendsBody(method) && body.trim() !== "";
  if (carriesBody && !hasHeader(headers, "content-type")) {
    // Guessed, not assumed: JSON is right nearly always here, but a caller who
    // set the header meant it.
    headers["Content-Type"] = looksLikeJson(body) ? "application/json" : "text/plain";
  }
  if (!hasHeader(headers, "accept")) headers["Accept"] = "*/*";

  return { method, url, headers, body: carriesBody ? { kind: "text", text: body } : undefined };
}

/** The path shown in history — the URL's path, since there's no operation. */
export function scratchPath(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    return url;
  }
}

/** Fill the pad from a recorded call — "Copy to a new request" for scratch entries. */
export function padFromHistory(entry: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}): ScratchPad {
  return {
    method: entry.method,
    url: entry.url,
    // Content-Type/Accept are re-derived on send; keeping them would slowly turn
    // every copy into a pad full of headers the user never typed.
    headers: Object.entries(entry.headers)
      .filter(([key]) => !["content-type", "accept"].includes(key.toLowerCase()))
      .map(([key, value]) => ({ key, value })),
    body: entry.body ?? "",
  };
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

function looksLikeJson(body: string): boolean {
  const trimmed = body.trim();
  if (!/^[{[]/.test(trimmed)) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}
