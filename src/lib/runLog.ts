import { invoke } from "@tauri-apps/api/core";
import type { ResolvedLink } from "./chain";
import type { FailureCause, RunEvent, SkipCause, StepDetail, TargetKind } from "./collectionRun";
import { redactDeep } from "./redact";
import { inTauri } from "./request";
import { readStore, writeStore } from "./store";

/**
 * The log of a collection run: its events, kept so a run can be read again
 * afterwards, copied as text or exported as JSON.
 *
 * Only these logs are written to disk, and only in redacted form: every event
 * is redacted when `runSteps` emits it, and again when it is stored or exported,
 * in case a secret was added to an environment since. They stay on this
 * computer, in `run-logs.json` next to the other stores.
 */

export const RUN_LOG_STORE = "run-logs.json";
/** Runs kept per collection, newest first. */
export const MAX_RUNS_PER_COLLECTION = 20;
/** Events kept per run. A run with more keeps its first ones and says it was cut. */
export const MAX_EVENTS_PER_RUN = 1000;
/** The whole file's size, roughly. The oldest runs go first when it is over. */
export const MAX_STORE_CHARS = 2_000_000;

export interface RunLog {
  /** The run's id; the same as its requests' `runId` in History. */
  id: string;
  collection: { id: string; name: string };
  environment: string | null;
  startedAt: string;
  finishedAt?: string;
  ms?: number;
  counts?: { total: number; passed: number; failed: number; skipped: number };
  stoppedEarly?: boolean;
  events: RunEvent[];
  /** Events were dropped to keep the log a sensible size. */
  truncated?: boolean;
}

export interface RunLogStore {
  version: 1;
  /** Collection id → its runs, newest first. */
  runs: Record<string, RunLog[]>;
}

export const EMPTY_RUN_LOGS: RunLogStore = { version: 1, runs: {} };

// ── building a log from events ────────────────────────────────────────────────

/** A log for a run that has just started. */
export function startLog(id: string, collection: { id: string; name: string }, environment: string | null, at: string): RunLog {
  return { id, collection, environment, startedAt: at, events: [] };
}

/** The log with one more event. The run's totals are filled in from `run_finished`. */
export function appendEvent(log: RunLog, event: RunEvent): RunLog {
  const events = log.events.length < MAX_EVENTS_PER_RUN || event.type === "run_finished" ? [...log.events, event] : log.events;
  const next: RunLog = { ...log, events, ...(events === log.events ? { truncated: true } : {}) };
  if (event.type === "run_started") next.startedAt = event.at;
  if (event.type === "run_finished") {
    next.finishedAt = event.at;
    next.ms = event.ms;
    next.counts = { total: event.total, passed: event.passed, failed: event.failed, skipped: event.skipped };
    next.stoppedEarly = event.stoppedEarly;
  }
  return next;
}

// ── keeping them ──────────────────────────────────────────────────────────────

const size = (value: unknown) => JSON.stringify(value).length;

/** A run too big for the file on its own keeps its outline: start, each step's result, finish. */
function outline(log: RunLog): RunLog {
  const kept = log.events.filter((e) => e.type === "run_started" || e.type === "step_result" || e.type === "run_finished");
  return { ...log, events: kept, truncated: true };
}

/**
 * The store with `log` added as its collection's newest run: redacted, at most
 * `MAX_RUNS_PER_COLLECTION` per collection, and the whole under
 * `MAX_STORE_CHARS`, dropping the oldest runs of any collection first.
 */
export function addRun(store: RunLogStore, log: RunLog): RunLogStore {
  const clean = redactDeep(log);
  const existing = (store.runs[log.collection.id] ?? []).filter((run) => run.id !== log.id);
  const runs: Record<string, RunLog[]> = {
    ...store.runs,
    [log.collection.id]: [clean, ...existing].slice(0, MAX_RUNS_PER_COLLECTION),
  };
  let next: RunLogStore = { version: 1, runs };
  while (size(next) > MAX_STORE_CHARS) {
    // The oldest run anywhere, other than the one just added.
    let oldest: { collection: string; index: number; at: string } | null = null;
    for (const [collection, list] of Object.entries(next.runs)) {
      list.forEach((run, index) => {
        if (run.id === log.id) return;
        if (!oldest || run.startedAt < oldest.at) oldest = { collection, index, at: run.startedAt };
      });
    }
    if (!oldest) {
      // Only the new run is left and it's still too big: keep its outline.
      next = { version: 1, runs: { ...next.runs, [log.collection.id]: [outline(clean)] } };
      break;
    }
    const { collection, index } = oldest as { collection: string; index: number };
    const list = next.runs[collection].filter((_, i) => i !== index);
    const rest = { ...next.runs };
    if (list.length) rest[collection] = list;
    else delete rest[collection];
    next = { version: 1, runs: rest };
  }
  return next;
}

/** Forget one collection's runs. */
export function clearRuns(store: RunLogStore, collectionId: string): RunLogStore {
  if (!store.runs[collectionId]) return store;
  const runs = { ...store.runs };
  delete runs[collectionId];
  return { version: 1, runs };
}

/** Forget the runs of collections that no longer exist. */
export function keepCollections(store: RunLogStore, ids: ReadonlySet<string>): RunLogStore {
  const stale = Object.keys(store.runs).filter((id) => !ids.has(id));
  if (!stale.length) return store;
  const runs = { ...store.runs };
  for (const id of stale) delete runs[id];
  return { version: 1, runs };
}

function isLog(value: unknown): value is RunLog {
  const log = value as RunLog;
  return Boolean(log && typeof log.id === "string" && log.collection && Array.isArray(log.events));
}

export async function loadRunLogs(): Promise<RunLogStore> {
  const stored = await readStore<Partial<RunLogStore>>(RUN_LOG_STORE, EMPTY_RUN_LOGS);
  const runs: Record<string, RunLog[]> = {};
  for (const [id, list] of Object.entries(stored.runs ?? {})) {
    if (Array.isArray(list)) runs[id] = list.filter(isLog).slice(0, MAX_RUNS_PER_COLLECTION);
  }
  return { version: 1, runs };
}

export async function saveRunLogs(store: RunLogStore): Promise<void> {
  await writeStore(RUN_LOG_STORE, store);
}

// ── reading one ───────────────────────────────────────────────────────────────

export type SchemaResult = Extract<StepDetail, { type: "schema_check" }>;
export type StatusCheck = Extract<StepDetail, { type: "status_check" }>;

/** One step of a run, put together from its events. */
export interface StepTimeline {
  index: number;
  key: string;
  name: string;
  verdict: "pass" | "fail" | "skipped" | "running";
  /** When it started, in ms from the run's start. */
  t?: number;
  at?: string;
  method?: string;
  url?: string;
  target?: string;
  targetKind?: TargetKind;
  requestHeaders?: Record<string, string>;
  status?: number;
  statusText?: string;
  ms?: number;
  bytes?: number;
  links: ResolvedLink[];
  schema?: SchemaResult;
  expected?: StatusCheck;
  warnings?: string[];
  error?: string;
  reason?: string;
  cause?: FailureCause | SkipCause;
  events: RunEvent[];
}

/** The run's steps in order, each with what happened to it. */
export function timeline(log: RunLog): StepTimeline[] {
  const steps = new Map<number, StepTimeline>();
  const get = (index: number, key: string, name?: string) => {
    let step = steps.get(index);
    if (!step) {
      step = { index, key, name: name ?? key, verdict: "running", links: [], events: [] };
      steps.set(index, step);
    }
    return step;
  };
  for (const event of log.events) {
    if (event.type === "run_started" || event.type === "run_finished") continue;
    const step = get(event.index, event.key, "name" in event ? event.name : undefined);
    step.events.push(event);
    switch (event.type) {
      case "step_started":
        Object.assign(step, {
          name: event.name,
          t: event.t,
          at: event.at,
          ...(event.method ? { method: event.method } : {}),
          ...(event.url ? { url: event.url } : {}),
          ...(event.target ? { target: event.target } : {}),
          ...(event.targetKind ? { targetKind: event.targetKind } : {}),
        });
        break;
      case "references_resolved":
        step.links.push(...event.links);
        break;
      case "request_sent":
        step.method = event.method;
        step.url = event.url;
        step.requestHeaders = event.headers;
        if (event.targetKind) step.targetKind = event.targetKind;
        break;
      case "request_failed":
        step.error = event.error;
        break;
      case "response_received":
        step.status = event.status;
        step.statusText = event.statusText;
        step.ms = event.ms;
        step.bytes = event.bytes;
        if (event.warnings?.length) step.warnings = event.warnings;
        break;
      case "schema_check":
        step.schema = event;
        break;
      case "status_check":
        step.expected = event;
        break;
      case "step_result":
        step.verdict = event.verdict;
        step.name = event.name;
        if (event.reason) step.reason = event.reason;
        if (event.cause) step.cause = event.cause;
        if (event.ms !== undefined && step.ms === undefined) step.ms = event.ms;
        if (step.t === undefined) {
          step.t = event.t;
          step.at = event.at;
        }
        break;
    }
  }
  return [...steps.values()].sort((a, b) => a.index - b.index);
}

/** A few words for why a step failed or didn't run. */
export function describeCause(cause: FailureCause | SkipCause | undefined): string {
  switch (cause) {
    case "reference":
      return "Unresolved value";
    case "network":
      return "Network error";
    case "status":
      return "Unexpected status";
    case "schema":
      return "Schema difference";
    case "setup":
      return "Couldn't build the request";
    case "error":
      return "Error";
    case "stopped":
      return "Stopped";
    case "earlier_failure":
      return "An earlier step failed";
    default:
      return "";
  }
}

export function describeTargetKind(kind: TargetKind | undefined): string {
  switch (kind) {
    case "server":
      return "server";
    case "mock":
      return "hosted mock";
    case "local-mock":
      return "local mock";
    case "custom":
      return "custom URL";
    case "url":
      return "request URL";
    default:
      return "";
  }
}

export function describeSchema(schema: SchemaResult | undefined): string {
  if (!schema) return "not checked";
  switch (schema.result) {
    case "ok":
      return "matches the spec";
    case "mismatch":
      return `${schema.findings} difference${schema.findings === 1 ? "" : "s"} from the spec`;
    case "error":
      return `couldn't check${schema.note ? `: ${schema.note}` : ""}`;
    default:
      return `not checked${schema.note ? `: ${schema.note}` : ""}`;
  }
}

/** The run's one-line result. */
export function describeCounts(log: RunLog): string {
  if (!log.counts) return "Didn't finish";
  const { passed, failed, skipped } = log.counts;
  const parts = [`${passed} passed`, `${failed} failed`];
  if (skipped) parts.push(`${skipped} skipped`);
  return `${parts.join(" · ")}${log.ms !== undefined ? ` · ${log.ms} ms` : ""}`;
}

const pad = (text: string, width: number) => (text.length >= width ? text : text + " ".repeat(width - text.length));

/**
 * The run as plain text, to paste into an issue or a chat. Redacted again here,
 * so a log stored before a secret was added doesn't carry it out.
 */
export function runLogText(log: RunLog): string {
  const clean = redactDeep(log);
  const started = clean.events.find((e) => e.type === "run_started");
  const lines = [
    `${clean.collection.name}: run ${clean.startedAt}`,
    `Environment: ${clean.environment ?? "none"}`,
  ];
  if (started?.type === "run_started") {
    lines.push(`Steps: ${started.steps}${started.stopOnFailure ? " · stops at the first failure" : ""}`);
    if (started.targets.length) lines.push(`Targets: ${started.targets.join(", ")}`);
  }
  lines.push(`Result: ${describeCounts(clean)}${clean.stoppedEarly ? " · stopped early" : ""}`);
  if (clean.finishedAt) lines.push(`Finished: ${clean.finishedAt}`);
  if (clean.truncated) lines.push("(Some events were left out to keep the log small.)");
  lines.push("");
  for (const step of timeline(clean)) {
    const when = step.t !== undefined ? `+${step.t} ms` : "";
    const verdict = step.verdict.toUpperCase();
    const request = [step.method, step.url].filter(Boolean).join(" ");
    lines.push(`${pad(when, 10)} ${step.index + 1}. ${step.name}  ${verdict}`);
    if (request) lines.push(`${" ".repeat(11)}${request}${step.targetKind ? ` (${describeTargetKind(step.targetKind)})` : ""}`);
    for (const link of step.links) {
      lines.push(
        `${" ".repeat(11)}${link.target ? `${link.target} ← ` : ""}${link.source}${
          link.error ? `: couldn't resolve (${link.error})` : ` = ${link.value}`
        }`,
      );
    }
    if (step.error) lines.push(`${" ".repeat(11)}Network error: ${step.error}`);
    if (step.status !== undefined) {
      lines.push(
        `${" ".repeat(11)}Response: ${step.status}${step.statusText ? ` ${step.statusText}` : ""}${
          step.ms !== undefined ? ` · ${step.ms} ms` : ""
        }${step.bytes !== undefined ? ` · ${step.bytes} bytes` : ""}`,
      );
    }
    if (step.expected) {
      lines.push(`${" ".repeat(11)}Expected status: ${step.expected.expected} (${step.expected.ok ? "ok" : `got ${step.expected.actual}`})`);
    }
    if (step.status !== undefined) lines.push(`${" ".repeat(11)}Schema: ${describeSchema(step.schema)}`);
    for (const warning of step.warnings ?? []) lines.push(`${" ".repeat(11)}Local mock: ${warning}`);
    if (step.verdict !== "pass" && step.reason) {
      const cause = describeCause(step.cause);
      lines.push(`${" ".repeat(11)}${cause ? `${cause}: ` : ""}${step.reason}`);
    } else if (step.reason) {
      lines.push(`${" ".repeat(11)}${step.reason}`);
    }
  }
  return lines.join("\n");
}

/** The run as JSON, for tools. Every value redacted. */
export function runLogJson(log: RunLog): string {
  return JSON.stringify({ format: "spec0-studio-run-log", formatVersion: 1, ...redactDeep(log) }, null, 2);
}

/** A file name for an exported run. */
export function runLogFileName(log: RunLog, extension: "json" | "txt"): string {
  const name = log.collection.name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "collection";
  const stamp = log.startedAt.replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");
  return `${name}-${stamp}.spec0-run.${extension}`;
}

// ── exporting ─────────────────────────────────────────────────────────────────

const EXPORT_SUFFIX = /\.spec0-run\.(json|txt)$/i;

/** Make sure a chosen path ends in `.spec0-run.<ext>`, the only names Rust will write. */
export function withRunLogSuffix(path: string, extension: "json" | "txt"): string {
  if (EXPORT_SUFFIX.test(path) && path.toLowerCase().endsWith(extension)) return path;
  return `${path.replace(EXPORT_SUFFIX, "").replace(/\.(json|txt)$/i, "")}.spec0-run.${extension}`;
}

/**
 * Save a run's log where the user picks. In the desktop app a save dialog asks
 * where and Rust writes the file (only `*.spec0-run.json` or `.txt`); in the
 * browser preview it downloads. Returns the file name, or null when cancelled.
 */
export async function exportRunLog(log: RunLog, extension: "json" | "txt"): Promise<string | null> {
  const text = extension === "json" ? runLogJson(log) : runLogText(log);
  const suggested = runLogFileName(log, extension);
  if (!inTauri) {
    const url = URL.createObjectURL(new Blob([text], { type: extension === "json" ? "application/json" : "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = suggested;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return suggested;
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  const picked = await save({
    defaultPath: suggested,
    filters: [{ name: extension === "json" ? "Run log (JSON)" : "Run log (text)", extensions: [extension] }],
  });
  if (typeof picked !== "string") return null;
  const path = withRunLogSuffix(picked, extension);
  await invoke("write_run_log", { path, contents: text });
  return path;
}
