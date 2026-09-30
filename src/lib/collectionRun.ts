import { resolveStepRefs, type ResolvedLink, type StepOutput } from "./chain";
import { describeExpected, expectedStatusOf, statusMatches, type CollectionStep } from "./collection";
import { unresolved } from "./env";
import type { HistoryEntry } from "./history";
import { buildPlan, type AuthState, type BodyInput, type RequestPlan } from "./request";
import { redactDeep } from "./redact";
import { buildScratchPlan } from "./scratch";
import type { OperationSpec } from "./spec";
import type { ValidationResult } from "./validate";

/**
 * Running a collection: building each step's request, deciding whether it
 * passed, and running the steps in order.
 *
 * Steps run one at a time, in order, because a later step may use an earlier
 * one's response, and because a burst of requests at a service is a load test
 * nobody asked for.
 */

export type StepVerdict = "pass" | "fail" | "not_run";

export interface StepResult {
  key: string;
  verdict: StepVerdict;
  /** A sentence: why it failed, or why it didn't run. */
  reason?: string;
  status?: number;
  ms?: number;
  /** The schema check, when the step is linked to an operation and got a response. */
  validation?: ValidationResult;
  /** What came back, for later steps and for picking values from. */
  output?: StepOutput;
  /** What was sent, secrets included only in memory; history stores it redacted. */
  request?: RequestPlan;
  /** Sent to a mock rather than a real server. */
  mock?: boolean;
  /** What a local mock said didn't match the spec in the request it was sent. */
  mockWarnings?: string[];
}

/**
 * The problems a local mock found in a request, from its
 * `X-Spec0-Mock-Warnings` header (`; `-separated). Empty when there were none.
 */
export function mockWarnings(headers: Record<string, string>): string[] {
  const value = Object.entries(headers).find(([name]) => name.toLowerCase() === "x-spec0-mock-warnings")?.[1];
  return value ? value.split(/;\s+/).map((part) => part.trim()).filter(Boolean) : [];
}

// Building a step's request

export interface PlanContext {
  /** The operation the step points at; null for an unlinked request. */
  op: OperationSpec | null;
  /** Where the request goes. Unused for an unlinked request, whose URL is complete. */
  baseUrl: string;
  vars: Record<string, string>;
  keys: readonly string[];
  outputs: ReadonlyMap<string, StepOutput>;
  /** The step's auth with its value ready to send (an OAuth token already fetched). */
  auth: AuthState | null;
  mock?: { url: string; key?: string; bearer?: string } | null;
}

function fillBody(body: BodyInput | undefined, fill: (text: string) => string): BodyInput {
  if (body === undefined) return "";
  if (typeof body === "string") return fill(body);
  if (body.kind === "form") return { kind: "form", fields: body.fields.map((f) => ({ ...f, value: fill(f.value) })) };
  return { kind: "multipart", parts: body.parts.map((p) => (p.value === undefined ? p : { ...p, value: fill(p.value) })) };
}

function planText(plan: RequestPlan): string {
  const body =
    plan.body?.kind === "text"
      ? plan.body.text
      : plan.body?.kind === "form"
        ? plan.body.fields.map(([, v]) => v).join("\n")
        : plan.body?.kind === "multipart"
          ? plan.body.parts.map((p) => p.value ?? "").join("\n")
          : "";
  let url = plan.url;
  try {
    url = decodeURIComponent(plan.url);
  } catch {
    // Not percent-encoded consistently; check it as it is.
  }
  return [url, ...Object.values(plan.headers), body].join("\n");
}

/**
 * Build the request for one step, or say why it can't be built.
 *
 * References to earlier steps are filled in first, then environment variables.
 * Anything still unfilled stops the step before it is sent: a request with
 * `{{orderId}}` in its path would only produce a 404 that looks like a finding.
 */
export function planStep(
  step: CollectionStep,
  context: PlanContext,
): { plan: RequestPlan; links?: ResolvedLink[] } | { error: string; links?: ResolvedLink[] } {
  const errors: string[] = [];
  const links: ResolvedLink[] = [];
  const fill = (text: string, target = "") => {
    const result = resolveStepRefs(text, context, target);
    errors.push(...result.errors);
    links.push(...result.links);
    return result.text;
  };
  const labelled = (values: Record<string, string>, where: string) =>
    Object.fromEntries(Object.entries(values).map(([k, v]) => [k, fill(v, `${where} ${k}`)]));
  const pathParams = labelled(step.pathParams, "path");
  const queryParams = labelled(step.queryParams, "query");
  const headers = labelled(step.headers, "header");
  const body = fillBody(step.body, (text) => fill(text, "body"));
  const auth = context.auth ? { ...context.auth, value: fill(context.auth.value, "auth") } : null;
  const baseUrl = fill(context.baseUrl, "target");
  const url = step.request ? fill(step.request.url, "url") : "";
  const withLinks = links.length ? { links } : {};
  if (errors.length) return { error: [...new Set(errors)].join("; "), ...withLinks };

  let plan: RequestPlan;
  try {
    if (context.op) {
      plan = buildPlan(context.op, baseUrl, pathParams, queryParams, headers, auth, body, context.vars, context.mock);
    } else if (step.request) {
      plan = buildScratchPlan(
        {
          method: step.request.method,
          url,
          headers: Object.entries(headers).map(([key, value]) => ({ key, value })),
          body: typeof body === "string" ? body : "",
        },
        context.vars,
      );
    } else {
      return { error: "This step has no operation and no URL.", ...withLinks };
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), ...withLinks };
  }

  const missing = unresolved(planText(plan), context.vars);
  if (missing.length) {
    const names = missing.map((name) => `{{${name}}}`).join(", ");
    return {
      error: `No value for ${names}. Set ${missing.length > 1 ? "them" : "it"} in the active environment.`,
      // Listed with the step references, so the log shows every value that was missing.
      links: [
        ...links,
        ...missing.map((name) => ({ target: "", source: `env.${name}`, error: "no value in the active environment" })),
      ],
    };
  }
  return { plan, ...withLinks };
}

// Pass or fail

/**
 * Whether a step passed: a response came back with the status the step
 * expects (any 2xx unless it says otherwise), and it matches what the spec
 * declares for that status.
 *
 * The schema is the one the spec gives for the status that came back, so a
 * step expecting 404 is checked against the spec's 404 response. A response
 * the spec has no schema for passes on its status, and the result says it
 * wasn't checked, so "pass" never quietly means "checked".
 */
export function verdictFor(
  status: number,
  validation: ValidationResult | null,
  expected?: string,
): { verdict: "pass" | "fail"; reason?: string } {
  if (!statusMatches(expected, status)) {
    const want = expectedStatusOf({ expect: expected ? { status: expected } : undefined });
    return {
      verdict: "fail",
      reason: want
        ? `Expected ${describeExpected(want)}, but the server answered ${status}.`
        : `The server answered ${status}.`,
    };
  }
  if (!validation) return { verdict: "pass", reason: "Not checked: this request isn't linked to an operation." };
  if (validation.status === "mismatch") {
    const n = validation.findings.length;
    return { verdict: "fail", reason: `The response doesn't match the spec: ${n} difference${n === 1 ? "" : "s"}.` };
  }
  if (validation.status === "error") return { verdict: "fail", reason: validation.note ?? "The response couldn't be checked." };
  if (validation.status === "no_schema") return { verdict: "pass", reason: `Not checked: ${validation.note ?? "no schema declared."}` };
  return { verdict: "pass" };
}

// Running in order

// What happened, as events

/** Where a step's request went. `url` is an unlinked request's own address. */
export type TargetKind = "server" | "mock" | "local-mock" | "custom" | "url";

/** Why a step failed, for the log: each has its own wording and colour there. */
export type FailureCause = "reference" | "network" | "status" | "schema" | "setup" | "error";

/** Why a step didn't run. */
export type SkipCause = "stopped" | "earlier_failure";

/**
 * What a step reports while it runs, in order. The step's index and key are
 * added by `runSteps`, and every value is redacted before it leaves it.
 */
export type StepDetail =
  | { type: "references_resolved"; links: ResolvedLink[] }
  | { type: "request_sent"; method: string; url: string; headers: Record<string, string>; targetKind?: TargetKind }
  | { type: "request_failed"; error: string }
  | { type: "response_received"; status: number; statusText?: string; ms: number; bytes: number; warnings?: string[] }
  | { type: "schema_check"; result: "ok" | "mismatch" | "not_checked" | "error"; findings: number; note?: string }
  | { type: "status_check"; expected: string; actual: number; ok: boolean };

/** A run's events, without their times. */
export type RunEventBody =
  | {
      type: "run_started";
      collection: { id: string; name: string };
      environment: string | null;
      steps: number;
      /** Where the steps go, one line each, in step order and without repeats. */
      targets: string[];
      stopOnFailure: boolean;
    }
  | {
      type: "step_started";
      index: number;
      key: string;
      name: string;
      method?: string;
      /** The base URL (or the whole URL of an unlinked request), when known before it's built. */
      url?: string;
      target?: string;
      targetKind?: TargetKind;
    }
  | (StepDetail & { index: number; key: string })
  | {
      type: "step_result";
      index: number;
      key: string;
      name: string;
      verdict: "pass" | "fail" | "skipped";
      reason?: string;
      cause?: FailureCause | SkipCause;
      status?: number;
      ms?: number;
    }
  | {
      type: "run_finished";
      total: number;
      passed: number;
      failed: number;
      skipped: number;
      ms: number;
      stoppedEarly: boolean;
      /** Why the run stopped early: the user, or the first failure. */
      stopReason?: SkipCause;
    };

/** One event: when it happened (ISO) and how long into the run (ms). */
export type RunEvent = RunEventBody & { at: string; t: number };

/** What a step looks like before it runs: its name, method and where it goes. */
export interface StepDescription {
  name: string;
  method?: string;
  url?: string;
  target?: string;
  targetKind?: TargetKind;
}

export interface RunOptions {
  stopOnFailure: boolean;
  /** Checked before each step; true stops the run with the rest marked as not run. */
  cancelled?: () => boolean;
  /** Called after each step, so results show as they land. */
  onResult?: (results: StepResult[]) => void;
  /** Every event of the run, in order, already redacted. */
  onEvent?: (event: RunEvent) => void;
  /** What the run is, for its first event. Without it there is no `run_started`. */
  run?: { collection: { id: string; name: string }; environment: string | null; targets: string[] };
  /** Describes a step for its `step_started` event. The key is used as the name without it. */
  describe?: (step: CollectionStep, index: number) => StepDescription;
  /** The clock, for tests. */
  now?: () => number;
}

/** Longest value kept in an event; a reference can resolve to a whole body. */
const MAX_EVENT_TEXT = 2000;

function clip(value: unknown): unknown {
  if (typeof value === "string") return value.length > MAX_EVENT_TEXT ? `${value.slice(0, MAX_EVENT_TEXT - 1)}…` : value;
  if (Array.isArray(value)) return value.map(clip);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, clip(v)]));
  }
  return value;
}

/**
 * Run steps in order with `execute`, which sends one step and reports how it
 * went. Each step sees the outputs of the steps before it.
 *
 * With `stopOnFailure`, the first failure ends the run and every later step is
 * reported as not run, with the reason, rather than left out: a run that only
 * lists what it did reads as though that was everything.
 *
 * With `onEvent`, the run is also told as events: started, each step started,
 * what the step reported through its `emit`, each step's result (with why it
 * failed or was skipped), finished. Every value is redacted with the known
 * secrets before it is handed over.
 */
export async function runSteps(
  steps: readonly CollectionStep[],
  execute: (
    step: CollectionStep,
    outputs: ReadonlyMap<string, StepOutput>,
    index: number,
    emit: (detail: StepDetail) => void,
  ) => Promise<StepResult>,
  options: RunOptions,
): Promise<StepResult[]> {
  const results: StepResult[] = [];
  const outputs = new Map<string, StepOutput>();
  let stopped: string | null = null;
  let stopCause: SkipCause | undefined;
  const now = options.now ?? (() => Date.now());
  const start = now();
  const send = (body: RunEventBody, at = now()) => {
    if (!options.onEvent) return;
    options.onEvent(redactDeep(clip({ ...body, at: new Date(at).toISOString(), t: at - start })) as RunEvent);
  };
  if (options.run) {
    send({ type: "run_started", ...options.run, steps: steps.length, stopOnFailure: options.stopOnFailure }, start);
  }

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const described = options.describe?.(step, index) ?? { name: step.name || step.key };
    if (!stopped && options.cancelled?.()) {
      stopped = "The run was stopped.";
      stopCause = "stopped";
    }
    if (stopped) {
      results.push({ key: step.key, verdict: "not_run", reason: stopped });
      send({
        type: "step_result",
        index,
        key: step.key,
        name: described.name,
        verdict: "skipped",
        reason: stopped,
        cause: stopCause,
      });
      continue;
    }
    send({ type: "step_started", index, key: step.key, ...described });
    const seen = { reference: false, network: false, status: false, schema: false };
    const emit = (detail: StepDetail) => {
      if (detail.type === "references_resolved" && detail.links.some((link) => link.error)) seen.reference = true;
      if (detail.type === "request_failed") seen.network = true;
      if (detail.type === "status_check" && !detail.ok) seen.status = true;
      if (detail.type === "schema_check" && (detail.result === "mismatch" || detail.result === "error")) seen.schema = true;
      send({ ...detail, index, key: step.key });
    };
    let result: StepResult;
    let threw = false;
    try {
      result = await execute(step, outputs, index, emit);
    } catch (error) {
      threw = true;
      result = { key: step.key, verdict: "fail", reason: error instanceof Error ? error.message : String(error) };
    }
    results.push(result);
    const cause: FailureCause | undefined =
      result.verdict !== "fail"
        ? undefined
        : threw
          ? "error"
          : seen.reference
            ? "reference"
            : seen.network
              ? "network"
              : seen.status
                ? "status"
                : seen.schema
                  ? "schema"
                  : "setup";
    send({
      type: "step_result",
      index,
      key: step.key,
      name: described.name,
      verdict: result.verdict === "fail" ? "fail" : "pass",
      ...(result.reason ? { reason: result.reason } : {}),
      ...(cause ? { cause } : {}),
      ...(result.status !== undefined ? { status: result.status } : {}),
      ...(result.ms !== undefined ? { ms: result.ms } : {}),
    });
    // A failed step that still got a response offers it to later steps; one
    // that never sent has nothing to offer.
    if (result.output) outputs.set(step.key, result.output);
    if (result.verdict === "fail" && options.stopOnFailure) {
      stopped = `Not run: step ${index + 1} (${step.key}) failed and the run stops at the first failure.`;
      stopCause = "earlier_failure";
    }
    options.onResult?.([...results]);
  }
  if (stopped) options.onResult?.([...results]);
  const summary = summariseRun(results);
  send({
    type: "run_finished",
    total: summary.total,
    passed: summary.passed,
    failed: summary.failed,
    skipped: summary.notRun,
    ms: now() - start,
    stoppedEarly: summary.notRun > 0,
    ...(stopCause && summary.notRun > 0 ? { stopReason: stopCause } : {}),
  });
  return results;
}

export interface CollectionRunSummary {
  total: number;
  passed: number;
  failed: number;
  notRun: number;
  ms: number;
}

export function summariseRun(results: readonly StepResult[]): CollectionRunSummary {
  return {
    total: results.length,
    passed: results.filter((r) => r.verdict === "pass").length,
    failed: results.filter((r) => r.verdict === "fail").length,
    notRun: results.filter((r) => r.verdict === "not_run").length,
    ms: results.reduce((sum, r) => sum + (r.ms ?? 0), 0),
  };
}

export function describeRun(summary: CollectionRunSummary): string {
  const parts = [`${summary.passed} passed`];
  if (summary.failed) parts.push(`${summary.failed} failed`);
  if (summary.notRun) parts.push(`${summary.notRun} not run`);
  return `${parts.join(" · ")} · ${summary.ms} ms`;
}

// In history

export type HistoryRow =
  | { kind: "entry"; entry: HistoryEntry }
  | { kind: "run"; runId: string; name: string; at: string; entries: HistoryEntry[]; passed: number; failed: number };

/**
 * History as rows, with each collection run folded into one.
 *
 * The run appears where its newest request is, and its requests are listed in
 * step order inside it. Requests from anything else stay as they were.
 */
export function historyRows(entries: readonly HistoryEntry[]): HistoryRow[] {
  const rows: HistoryRow[] = [];
  const runs = new Map<string, Extract<HistoryRow, { kind: "run" }>>();
  for (const entry of entries) {
    if (!entry.collection || !entry.runId) {
      rows.push({ kind: "entry", entry });
      continue;
    }
    const existing = runs.get(entry.runId);
    if (existing) {
      existing.entries.push(entry);
      continue;
    }
    const row: Extract<HistoryRow, { kind: "run" }> = {
      kind: "run",
      runId: entry.runId,
      name: entry.collection.name,
      at: entry.at,
      entries: [entry],
      passed: 0,
      failed: 0,
    };
    runs.set(entry.runId, row);
    rows.push(row);
  }
  for (const row of runs.values()) {
    row.entries.sort((a, b) => (a.collection?.index ?? 0) - (b.collection?.index ?? 0));
    row.passed = row.entries.filter((e) => e.collection?.passed).length;
    row.failed = row.entries.length - row.passed;
  }
  return rows;
}
