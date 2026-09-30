import { redact, redactDeep } from "./redact";

/**
 * The app console: what Studio did in this session, as it happened. Requests
 * sent and what came back, collection runs, requests to local mocks, and MCP
 * tool calls.
 *
 * It lives in memory only. Nothing here is written to disk or sent anywhere,
 * and it is gone when Studio quits. It keeps the last `MAX_CONSOLE_ENTRIES`.
 * Every text is redacted with the known secrets as it is added, and MCP calls
 * are logged by tool name and outcome only: their arguments can hold anything.
 */

export const MAX_CONSOLE_ENTRIES = 1000;

export type ConsoleSource = "request" | "collection" | "mock" | "mcp";

export interface ConsoleEntry {
  id: number;
  at: string;
  source: ConsoleSource;
  level: "info" | "error";
  /** One line: what happened. */
  text: string;
  method?: string;
  /** A URL, or a path for a local mock request. */
  url?: string;
  status?: number;
  ms?: number;
  /** A local mock's warnings about the request, or an error's reason. */
  notes?: string[];
  /** For a collection run: which one, so the entry can open its log. */
  run?: { collectionId: string; runId: string };
  /** For an MCP call: the tool's name. */
  tool?: string;
}

export type ConsoleInput = Omit<ConsoleEntry, "id" | "at"> & { at?: string };

export type ConsoleFilter = "all" | "requests" | "collections" | "mock" | "mcp" | "errors";

export const CONSOLE_FILTERS: Array<{ id: ConsoleFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "requests", label: "Requests" },
  { id: "collections", label: "Collections" },
  { id: "mock", label: "Local mock" },
  { id: "mcp", label: "MCP" },
  { id: "errors", label: "Errors" },
];

export function matchesFilter(entry: ConsoleEntry, filter: ConsoleFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "requests":
      return entry.source === "request";
    case "collections":
      return entry.source === "collection";
    case "mock":
      return entry.source === "mock";
    case "mcp":
      return entry.source === "mcp";
    case "errors":
      return entry.level === "error";
  }
}

export function filterEntries(entries: readonly ConsoleEntry[], filter: ConsoleFilter, query = ""): ConsoleEntry[] {
  const needle = query.trim().toLowerCase();
  return entries.filter(
    (entry) =>
      matchesFilter(entry, filter) &&
      (!needle || [entry.text, entry.url, entry.method, entry.tool].some((part) => part?.toLowerCase().includes(needle))),
  );
}

/** One entry as a line of text. */
export function entryText(entry: ConsoleEntry): string {
  const parts = [entry.at, entry.source.toUpperCase(), entry.level === "error" ? "ERROR" : "", entry.text];
  const line = parts.filter(Boolean).join("  ");
  return entry.notes?.length ? `${line}\n${entry.notes.map((note) => `    ${note}`).join("\n")}` : line;
}

export function entriesText(entries: readonly ConsoleEntry[]): string {
  return entries.map(entryText).join("\n");
}

// ── the session's log ─────────────────────────────────────────────────────────

export interface ConsoleState {
  entries: ConsoleEntry[];
  /** Errors added since the console was last open. */
  unseenErrors: number;
  open: boolean;
  /** How many were dropped because the log was full. */
  dropped: number;
}

let state: ConsoleState = { entries: [], unseenErrors: 0, open: false, dropped: 0 };
let nextId = 1;
const listeners = new Set<() => void>();

function set(next: ConsoleState) {
  state = next;
  for (const listener of listeners) listener();
}

export function subscribeConsole(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function consoleState(): ConsoleState {
  return state;
}

/** Add an entry. Redacted here, so no caller can forget to. */
export function logToConsole(input: ConsoleInput): ConsoleEntry {
  const clean = redactDeep(input);
  const entry: ConsoleEntry = {
    ...clean,
    id: nextId++,
    at: input.at ?? new Date().toISOString(),
    text: redact(clean.text),
  };
  const all = [...state.entries, entry];
  const over = Math.max(0, all.length - MAX_CONSOLE_ENTRIES);
  set({
    ...state,
    entries: over ? all.slice(over) : all,
    dropped: state.dropped + over,
    unseenErrors: state.open || entry.level !== "error" ? state.unseenErrors : state.unseenErrors + 1,
  });
  return entry;
}

export function clearConsole(): void {
  set({ ...state, entries: [], unseenErrors: 0, dropped: 0 });
}

export function setConsoleOpen(open: boolean): void {
  set({ ...state, open, unseenErrors: open ? 0 : state.unseenErrors });
}

export function toggleConsole(): void {
  setConsoleOpen(!state.open);
}

/** For tests: back to an empty, closed console. */
export function resetConsole(): void {
  nextId = 1;
  set({ entries: [], unseenErrors: 0, open: false, dropped: 0 });
}

// ── what gets logged ──────────────────────────────────────────────────────────

/** A request Studio sent and what came back (or why nothing did). */
export function logRequest(request: { method: string; url: string }, outcome: { status: number; ms: number } | { error: string }) {
  if ("error" in outcome) {
    logToConsole({
      source: "request",
      level: "error",
      method: request.method,
      url: request.url,
      text: `${request.method} ${request.url} failed: ${outcome.error}`,
    });
    return;
  }
  logToConsole({
    source: "request",
    level: outcome.status >= 500 ? "error" : "info",
    method: request.method,
    url: request.url,
    status: outcome.status,
    ms: outcome.ms,
    text: `${request.method} ${request.url} → ${outcome.status} · ${outcome.ms} ms`,
  });
}

/**
 * An MCP tool call: its name and whether it worked. Never its arguments or its
 * answer, which can hold anything an agent sent.
 */
export function logMcpCall(tool: string, ok: boolean) {
  const name = /^[A-Za-z0-9_.-]{1,80}$/.test(tool) ? tool : "(unknown tool)";
  logToConsole({ source: "mcp", level: ok ? "info" : "error", tool: name, text: `MCP ${name} → ${ok ? "ok" : "error"}` });
}

/** A request a local mock received and how it answered. */
export function logMockRequest(
  mock: string,
  request: { method: string; path: string },
  response: { status: number },
  warnings: string[],
) {
  logToConsole({
    source: "mock",
    level: response.status >= 500 ? "error" : "info",
    method: request.method,
    url: request.path,
    status: response.status,
    ...(warnings.length ? { notes: warnings } : {}),
    text: `Local mock ${mock}: ${request.method} ${request.path} → ${response.status}${
      warnings.length ? ` · ${warnings.length} warning${warnings.length === 1 ? "" : "s"}` : ""
    }`,
  });
}
