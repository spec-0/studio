import { resolveStepRefs, type StepOutput } from "./chain";
import type { CollectionStep } from "./collection";
import { unresolved } from "./env";
import type { HistoryEntry } from "./history";
import { buildPlan, type AuthState, type BodyInput, type RequestPlan } from "./request";
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
}

// ── building a step's request ─────────────────────────────────────────────────

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

function mapValues(values: Record<string, string>, fill: (text: string) => string): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, fill(v)]));
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
export function planStep(step: CollectionStep, context: PlanContext): { plan: RequestPlan } | { error: string } {
  const errors: string[] = [];
  const fill = (text: string) => {
    const result = resolveStepRefs(text, context);
    errors.push(...result.errors);
    return result.text;
  };
  const pathParams = mapValues(step.pathParams, fill);
  const queryParams = mapValues(step.queryParams, fill);
  const headers = mapValues(step.headers, fill);
  const body = fillBody(step.body, fill);
  const auth = context.auth ? { ...context.auth, value: fill(context.auth.value) } : null;
  const baseUrl = fill(context.baseUrl);
  const url = step.request ? fill(step.request.url) : "";
  if (errors.length) return { error: [...new Set(errors)].join("; ") };

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
      return { error: "This step has no operation and no URL." };
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  const missing = unresolved(planText(plan), context.vars);
  if (missing.length) {
    const names = missing.map((name) => `{{${name}}}`).join(", ");
    return {
      error: `No value for ${names}. Set ${missing.length > 1 ? "them" : "it"} in the active environment.`,
    };
  }
  return { plan };
}

// ── pass or fail ──────────────────────────────────────────────────────────────

/**
 * Whether a step passed: a response came back, with a success status, that
 * matches what the spec declares for it.
 *
 * A response the spec has no schema for passes on its status, and the result
 * says it wasn't checked, so "pass" never quietly means "checked".
 */
export function verdictFor(status: number, validation: ValidationResult | null): { verdict: "pass" | "fail"; reason?: string } {
  if (status >= 400) return { verdict: "fail", reason: `The server answered ${status}.` };
  if (!validation) return { verdict: "pass", reason: "Not checked: this request isn't linked to an operation." };
  if (validation.status === "mismatch") {
    const n = validation.findings.length;
    return { verdict: "fail", reason: `The response doesn't match the spec: ${n} difference${n === 1 ? "" : "s"}.` };
  }
  if (validation.status === "error") return { verdict: "fail", reason: validation.note ?? "The response couldn't be checked." };
  if (validation.status === "no_schema") return { verdict: "pass", reason: `Not checked: ${validation.note ?? "no schema declared."}` };
  return { verdict: "pass" };
}

// ── running in order ──────────────────────────────────────────────────────────

export interface RunOptions {
  stopOnFailure: boolean;
  /** Checked before each step; true stops the run with the rest marked as not run. */
  cancelled?: () => boolean;
  /** Called after each step, so results show as they land. */
  onResult?: (results: StepResult[]) => void;
}

/**
 * Run steps in order with `execute`, which sends one step and reports how it
 * went. Each step sees the outputs of the steps before it.
 *
 * With `stopOnFailure`, the first failure ends the run and every later step is
 * reported as not run, with the reason, rather than left out: a run that only
 * lists what it did reads as though that was everything.
 */
export async function runSteps(
  steps: readonly CollectionStep[],
  execute: (step: CollectionStep, outputs: ReadonlyMap<string, StepOutput>, index: number) => Promise<StepResult>,
  options: RunOptions,
): Promise<StepResult[]> {
  const results: StepResult[] = [];
  const outputs = new Map<string, StepOutput>();
  let stopped: string | null = null;

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (!stopped && options.cancelled?.()) stopped = "The run was stopped.";
    if (stopped) {
      results.push({ key: step.key, verdict: "not_run", reason: stopped });
      continue;
    }
    let result: StepResult;
    try {
      result = await execute(step, outputs, index);
    } catch (error) {
      result = { key: step.key, verdict: "fail", reason: error instanceof Error ? error.message : String(error) };
    }
    results.push(result);
    // A failed step that still got a response offers it to later steps; one
    // that never sent has nothing to offer.
    if (result.output) outputs.set(step.key, result.output);
    if (result.verdict === "fail" && options.stopOnFailure) {
      stopped = `Not run: step ${index + 1} (${step.key}) failed and the run stops at the first failure.`;
    }
    options.onResult?.([...results]);
  }
  if (stopped) options.onResult?.([...results]);
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

// ── in history ────────────────────────────────────────────────────────────────

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
