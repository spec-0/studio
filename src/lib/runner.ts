import type { OperationSpec, ParamSpec } from "./spec";
import type { ValidationResult } from "./validate";
import { redact } from "./redact";

/**
 * Run every operation in a tag and report which responses match the spec.
 *
 * The question a developer actually has before a release is *"does any of this
 * still match the contract?"* — and answering it meant clicking through every
 * operation by hand.
 *
 * **Why this is different from a collection runner.** Postman's needs
 * hand-written assertions: someone writes `pm.expect(...)` per request, and the
 * suite is only as good as the effort spent on it and rots as the API moves.
 * Here the assertions come *free from the schema* — Studio already validates a
 * response against the declared schema for the status actually returned,
 * including undeclared-field drift. Running that across a tag is a conformance
 * check nobody had to write, and it stays correct as the spec changes because it
 * **is** the spec.
 */

/** Methods that don't change anything, and are therefore safe to run in bulk. */
const SAFE_METHODS = ["GET", "HEAD", "OPTIONS"];

export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.includes(method.toUpperCase());
}

export interface RunOptions {
  /**
   * Include methods that change state.
   *
   * Off by default. Not paternalism about the target — a caller who can reach an
   * endpoint could reach it without us — but "run all" is a bulk action where the
   * user didn't choose each request individually, which is a different thing from
   * deliberately firing one DELETE.
   */
  includeMutating: boolean;
}

export type SkipReason =
  | { kind: "mutating"; method: string }
  | { kind: "missing_params"; names: string[] }
  | { kind: "deprecated" };

export interface Planned {
  operation: OperationSpec;
  /** Values resolved for the path/query parameters, when it can run. */
  pathParams: Record<string, string>;
  queryParams: Record<string, string>;
  skip: SkipReason | null;
}

export type Verdict = "ok" | "mismatch" | "no_schema" | "error" | "skipped";

export interface RunResult {
  operation: OperationSpec;
  verdict: Verdict;
  skip?: SkipReason;
  status?: number;
  ms?: number;
  /** What the schema check said, when one ran. */
  validation?: ValidationResult;
  error?: string;
}

/**
 * Decide what can run, and why anything can't.
 *
 * **Required parameters are resolved from the environment by name, never
 * invented.** Studio generates plausible examples elsewhere — that's right for a
 * form a human is about to review, and wrong here: an invented `{orderId}`
 * produces a confident 404 that means nothing, and a page of those is worse than
 * a page of honest skips. A row saying "skipped: no value for orderId" tells you
 * what to fix; a fabricated 404 tells you nothing and looks like a finding.
 */
export function planRun(
  operations: OperationSpec[],
  vars: Record<string, string>,
  options: RunOptions,
): Planned[] {
  return operations.map((operation) => {
    const pathParams: Record<string, string> = {};
    const queryParams: Record<string, string> = {};
    const missing: string[] = [];

    for (const param of operation.parameters) {
      const value = vars[param.name];
      if (param.in === "path") {
        // Path parameters are structural: without one there is no URL to call.
        if (value === undefined || value === "") missing.push(param.name);
        else pathParams[param.name] = value;
      } else if (param.in === "query") {
        if (value !== undefined && value !== "") queryParams[param.name] = value;
        else if (param.required) missing.push(param.name);
      } else if (param.in === "header" && param.required && (value === undefined || value === "")) {
        missing.push(param.name);
      }
    }

    const skip: SkipReason | null = !options.includeMutating && !isSafeMethod(operation.method)
      ? { kind: "mutating", method: operation.method.toUpperCase() }
      : missing.length
        ? { kind: "missing_params", names: missing }
        : null;

    return { operation, pathParams, queryParams, skip };
  });
}

/** A sentence a person can act on. */
export function describeSkip(skip: SkipReason): string {
  if (skip.kind === "mutating") {
    return `${skip.method} changes state — enable mutating methods to include it`;
  }
  if (skip.kind === "deprecated") return "deprecated";
  const names = skip.names.map((name) => `{{${name}}}`).join(", ");
  return `no value for ${names} — set ${skip.names.length > 1 ? "them" : "it"} in the active environment`;
}

export interface RunSummary {
  total: number;
  matched: number;
  mismatched: number;
  unchecked: number;
  errored: number;
  skipped: number;
}

export function summarise(results: RunResult[]): RunSummary {
  const count = (verdict: Verdict) => results.filter((r) => r.verdict === verdict).length;
  return {
    total: results.length,
    matched: count("ok"),
    mismatched: count("mismatch"),
    unchecked: count("no_schema"),
    errored: count("error"),
    skipped: count("skipped"),
  };
}

/** One line, for the status strip. Says what happened without needing the table. */
export function describeSummary(summary: RunSummary): string {
  const parts = [`${summary.matched} matched`];
  if (summary.mismatched) parts.push(`${summary.mismatched} mismatched`);
  if (summary.errored) parts.push(`${summary.errored} errored`);
  if (summary.unchecked) parts.push(`${summary.unchecked} unchecked`);
  if (summary.skipped) parts.push(`${summary.skipped} skipped`);
  return parts.join(" · ");
}

/**
 * A report that can be pasted into a PR or an issue.
 *
 * Markdown rather than JSON because the destination is a human reading a review,
 * and **skips are listed rather than dropped** — a report that silently omits
 * what it didn't run reads as "all clear" when it isn't.
 */
export function toMarkdown(
  results: RunResult[],
  context: { title: string; target: string; scope: string },
): string {
  const summary = summarise(results);
  const lines = [
    `## ${context.title} — conformance run`,
    "",
    `**Scope:** ${context.scope} · **Target:** \`${context.target}\``,
    "",
    `${describeSummary(summary)} · ${summary.total} operations`,
    "",
    "| | Operation | Status | Result |",
    "| --- | --- | --- | --- |",
  ];

  for (const result of results) {
    const glyph =
      result.verdict === "ok"
        ? "✅"
        : result.verdict === "mismatch"
          ? "⚠️"
          : result.verdict === "error"
            ? "❌"
            : result.verdict === "skipped"
              ? "⏭️"
              : "➖";
    const detail =
      result.verdict === "skipped" && result.skip
        ? describeSkip(result.skip)
        : result.verdict === "error"
          ? (result.error ?? "request failed")
          : result.verdict === "mismatch"
            ? `${result.validation?.findings.length ?? 0} difference(s) from the declared schema`
            : result.verdict === "no_schema"
              ? "no schema declared for this status"
              : "matches the declared schema";
    const status = result.status ? `${result.status}${result.ms ? ` · ${result.ms}ms` : ""}` : "—";
    lines.push(
      `| ${glyph} | \`${result.operation.method} ${result.operation.path}\` | ${status} | ${detail} |`,
    );
  }

  const mismatches = results.filter((r) => r.verdict === "mismatch");
  if (mismatches.length) {
    lines.push("", "### Differences", "");
    for (const result of mismatches) {
      lines.push(`**\`${result.operation.method} ${result.operation.path}\`**`, "");
      for (const finding of result.validation?.findings ?? []) {
        lines.push(`- \`${finding.path || "(root)"}\` — ${finding.message}`);
      }
      lines.push("");
    }
  }

  // Meant to be pasted into a PR, so no secret value may survive into it — an
  // error message can quote a URL with an API key in its query.
  return redact(lines.join("\n"));
}

/** Which parameters an operation needs before it can run — for the pre-run summary. */
export function requiredParamNames(operation: OperationSpec): string[] {
  return operation.parameters
    .filter((param: ParamSpec) => param.in === "path" || param.required)
    .map((param) => param.name);
}
