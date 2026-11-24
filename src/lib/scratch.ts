import { interpolate } from "./env";
import type { RequestPlan } from "./request";
import { readStore, writeStore, STORE } from "./store";

/**
 * Scratch requests: ad-hoc requests to an API you have no spec for.
 *
 * Everything else in Studio starts from a spec, because the schema is what
 * powers body generation, response validation and the graph. But trying a few
 * endpoints of an API before there is a spec is a real way to start, so you can
 * have as many scratch requests as you like, each with its own last response.
 *
 * They stay plain on purpose. A scratch request has no name, no folder and
 * nothing that checks it; it is kept the way a text buffer is, until you remove
 * it. Keeping one means adding it to a collection, and describing it properly
 * means a spec. See design rule 12.
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
 * calls belong in it. But they must be distinguishable, because copying one
 * back out goes to a new scratch request, not to an operation.
 */
export const SCRATCH_TITLE = "Scratch";
export const SCRATCH_OPERATION_ID = "__scratch__";

export const EMPTY_PAD: ScratchPad = {
  method: "GET",
  url: "",
  headers: [],
  body: "",
};

/** One scratch request: what's in its editor, and an id that names it in tabs and the response pane. */
export interface ScratchRequest extends ScratchPad {
  id: string;
}

export interface ScratchState {
  version: 2;
  requests: ScratchRequest[];
  /** The one the scratch screen shows; null when there are none. */
  activeId: string | null;
}

export const EMPTY_SCRATCH: ScratchState = { version: 2, requests: [], activeId: null };

/** The id scratch tabs and the scratch jar use in place of an API's. */
export const SCRATCH_API_ID = "__scratch__";

export function newScratchId(): string {
  return `s_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Nothing typed yet: no URL, no headers, no body. */
export function isBlank(pad: ScratchPad): boolean {
  return pad.url.trim() === "" && pad.headers.every((row) => !row.key.trim() && !row.value.trim()) && pad.body.trim() === "";
}

function padOf(raw: Partial<ScratchPad> | undefined | null): ScratchPad {
  const stored = raw ?? {};
  return {
    method: typeof stored.method === "string" && stored.method ? stored.method : EMPTY_PAD.method,
    url: typeof stored.url === "string" ? stored.url : EMPTY_PAD.url,
    headers: Array.isArray(stored.headers)
      ? stored.headers.filter((row) => row && typeof row.key === "string" && typeof row.value === "string")
      : [],
    body: typeof stored.body === "string" ? stored.body : "",
  };
}

/**
 * Read what was stored, dropping anything that doesn't look like a request
 * rather than failing. The single pad older versions kept becomes the first
 * scratch request (when anything was typed in it).
 */
export function parseScratch(raw: unknown): ScratchState {
  if (!raw || typeof raw !== "object") return EMPTY_SCRATCH;
  const stored = raw as Partial<ScratchState> & Partial<ScratchPad>;
  if (stored.version !== 2 || !Array.isArray(stored.requests)) {
    const pad = padOf(stored);
    if (isBlank(pad)) return EMPTY_SCRATCH;
    const id = newScratchId();
    return { version: 2, requests: [{ id, ...pad }], activeId: id };
  }
  const seen = new Set<string>();
  const requests: ScratchRequest[] = [];
  for (const request of stored.requests) {
    if (!request || typeof request.id !== "string" || seen.has(request.id)) continue;
    seen.add(request.id);
    requests.push({ id: request.id, ...padOf(request) });
  }
  const activeId = requests.some((r) => r.id === stored.activeId) ? (stored.activeId as string) : (requests[0]?.id ?? null);
  return { version: 2, requests, activeId };
}

export async function loadScratch(): Promise<ScratchState> {
  return parseScratch(await readStore<unknown>(STORE.scratch, null));
}

export async function saveScratch(state: ScratchState): Promise<void> {
  await writeStore(STORE.scratch, state);
}

/**
 * Start a new scratch request, filled from `from` or empty, and show it.
 *
 * A blank request already in the list is reused rather than joined by a second
 * one, so pressing "New request" a few times doesn't leave a row of empty ones.
 */
export function addScratch(state: ScratchState, from: ScratchPad = EMPTY_PAD, id: string = newScratchId()): ScratchState {
  const blank = state.requests.find(isBlank);
  if (blank) {
    return {
      ...state,
      activeId: blank.id,
      requests: state.requests.map((r) => (r.id === blank.id ? { ...padOf(from), id: blank.id } : r)),
    };
  }
  return { ...state, activeId: id, requests: [...state.requests, { ...padOf(from), id }] };
}

/** Change one request's contents. */
export function updateScratch(state: ScratchState, id: string, pad: ScratchPad): ScratchState {
  if (!state.requests.some((r) => r.id === id)) return state;
  return { ...state, requests: state.requests.map((r) => (r.id === id ? { ...pad, id } : r)) };
}

/** Show another request. */
export function selectScratch(state: ScratchState, id: string): ScratchState {
  if (state.activeId === id || !state.requests.some((r) => r.id === id)) return state;
  return { ...state, activeId: id };
}

/** A copy of a request, right after it, shown. */
export function duplicateScratch(state: ScratchState, id: string, copyId: string = newScratchId()): ScratchState {
  const index = state.requests.findIndex((r) => r.id === id);
  if (index < 0) return state;
  const requests = [...state.requests];
  requests.splice(index + 1, 0, { ...state.requests[index], headers: state.requests[index].headers.map((h) => ({ ...h })), id: copyId });
  return { ...state, requests, activeId: copyId };
}

/**
 * Remove a request. When it was the one shown, the next one (or the one
 * before, at the end) is shown instead.
 */
export function removeScratch(state: ScratchState, id: string): ScratchState {
  const index = state.requests.findIndex((r) => r.id === id);
  if (index < 0) return state;
  const requests = state.requests.filter((r) => r.id !== id);
  if (state.activeId !== id) return { ...state, requests };
  return { ...state, requests, activeId: (requests[index] ?? requests[index - 1])?.id ?? null };
}

export function activeScratch(state: ScratchState): ScratchRequest | null {
  return state.requests.find((r) => r.id === state.activeId) ?? null;
}

/** How a request is named in lists and tabs: its path, or its host, or "New request". */
export function scratchLabel(pad: ScratchPad): string {
  const url = pad.url.trim();
  if (!url) return "New request";
  try {
    const parsed = new URL(url);
    const path = parsed.pathname + parsed.search;
    return path === "/" ? parsed.host : path;
  } catch {
    return url;
  }
}

/** The response pane's owner for a scratch request (see `paneOwner`). */
export function scratchOwner(id: string): string {
  return `scratch:${id}`;
}

/** Methods that carry a body: the same rule the spec-driven path uses. */
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
 * @throws when the URL is empty or doesn't resolve to something sendable; a
 *   clear message beats a fetch that fails obscurely.
 */
export function buildScratchPlan(pad: ScratchPad, vars: Record<string, string> = {}): RequestPlan {
  const fill = (value: string) => interpolate(value, vars);
  const method = pad.method.toUpperCase();

  const url = fill(pad.url).trim();
  if (!url) throw new Error("Enter a URL to send to.");
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`URL must start with http:// or https:// (got "${url}")`);
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

/** The path shown in history: the URL's path, since there's no operation. */
export function scratchPath(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    return url;
  }
}

/** A scratch request's contents from a recorded call ("Copy to a new request" for scratch entries). */
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
