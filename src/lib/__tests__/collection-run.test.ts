import { describe, expect, it } from "vitest";
import type { StepOutput } from "../chain";
import type { CollectionStep } from "../collection";
import { historyRows, mockWarnings, planStep, runSteps, summariseRun, describeRun, verdictFor, type StepResult } from "../collectionRun";
import type { HistoryEntry } from "../history";
import { SAMPLE_SPEC } from "../sample";
import { parseSpec } from "../spec";

const spec = parseSpec(SAMPLE_SPEC, "sample");
const op = (id: string) => spec.operations.find((o) => o.operationId === id)!;

const step = (key: string, extra: Partial<CollectionStep> = {}): CollectionStep => ({
  key,
  api: "orders",
  operation: { method: "GET", path: "/orders" },
  pathParams: {},
  queryParams: {},
  headers: {},
  ...extra,
});

const created: StepOutput = { status: 201, headers: {}, json: { id: "o_1" }, text: '{"id":"o_1"}' };

describe("building a step's request", () => {
  const base = {
    baseUrl: "{{baseUrl}}",
    vars: { baseUrl: "https://api.example.com/v1", token: "t0k" },
    keys: ["createOrder", "getOrder"],
    outputs: new Map([["createOrder", created]]),
    auth: { schemeName: "bearerAuth", type: "http", httpScheme: "bearer", value: "{{token}}" },
  };

  it("fills in earlier steps' values, then the environment", () => {
    const result = planStep(step("getOrder", { pathParams: { orderId: "{{steps.createOrder.body.id}}" } }), {
      ...base,
      op: op("getOrder"),
    });
    expect("plan" in result && result.plan.url).toBe("https://api.example.com/v1/orders/o_1");
    expect("plan" in result && result.plan.headers.Authorization).toBe("Bearer t0k");
  });

  it("fails before sending when a reference can't be filled", () => {
    const result = planStep(step("getOrder", { pathParams: { orderId: "{{steps.createOrder.body.nope}}" } }), {
      ...base,
      op: op("getOrder"),
    });
    expect(result).toEqual({ error: expect.stringMatching(/body\.nope: not in the response/) });
  });

  it("fails before sending when an environment variable has no value", () => {
    const result = planStep(step("getOrder", { pathParams: { orderId: "{{orderId}}" } }), { ...base, op: op("getOrder") });
    expect(result).toEqual({ error: "No value for {{orderId}}. Set it in the active environment." });
    const noToken = planStep(step("listOrders"), { ...base, vars: { baseUrl: base.vars.baseUrl }, op: op("listOrders") });
    expect(noToken).toEqual({ error: expect.stringMatching(/\{\{token\}\}/) });
  });

  it("builds an unlinked request from its URL", () => {
    const result = planStep(
      { key: "raw", request: { method: "post", url: "{{baseUrl}}/echo/{{steps.createOrder.body.id}}" }, pathParams: {}, queryParams: {}, headers: { "X-A": "1" }, body: '{"a":1}' },
      { ...base, op: null, auth: null },
    );
    expect("plan" in result && result.plan).toMatchObject({
      method: "POST",
      url: "https://api.example.com/v1/echo/o_1",
      headers: { "X-A": "1", "Content-Type": "application/json" },
    });
  });
});

describe("pass or fail", () => {
  it("passes a matching success response, fails an error status or a mismatch", () => {
    expect(verdictFor(200, { status: "ok", findings: [] }).verdict).toBe("pass");
    expect(verdictFor(404, { status: "ok", findings: [] })).toEqual({ verdict: "fail", reason: "The server answered 404." });
    expect(verdictFor(200, { status: "mismatch", findings: [{ kind: "extra_field", path: "$.x", message: "" }] })).toEqual({
      verdict: "fail",
      reason: "The response doesn't match the spec: 1 difference.",
    });
    expect(verdictFor(200, { status: "error", findings: [], note: "boom" }).verdict).toBe("fail");
  });

  it("says when a pass wasn't checked", () => {
    expect(verdictFor(204, { status: "no_schema", findings: [], note: "no schema." }).reason).toMatch(/^Not checked/);
    expect(verdictFor(200, null).reason).toMatch(/isn't linked/);
  });
});

describe("running steps in order", () => {
  const steps = [step("a"), step("b"), step("c")];
  const outcome = (verdicts: Record<string, "pass" | "fail">) => async (s: CollectionStep, outputs: ReadonlyMap<string, StepOutput>) => {
    const result: StepResult = {
      key: s.key,
      verdict: verdicts[s.key],
      status: verdicts[s.key] === "pass" ? 200 : 500,
      ms: 10,
      output: { status: 200, headers: {}, json: { seen: [...outputs.keys()] }, text: "" },
    };
    return result;
  };

  it("stops at the first failure and says why the rest didn't run", async () => {
    const results = await runSteps(steps, outcome({ a: "pass", b: "fail", c: "pass" }), { stopOnFailure: true });
    expect(results.map((r) => r.verdict)).toEqual(["pass", "fail", "not_run"]);
    expect(results[2].reason).toMatch(/step 2 \(b\) failed/);
  });

  it("keeps going when asked to", async () => {
    const results = await runSteps(steps, outcome({ a: "fail", b: "pass", c: "pass" }), { stopOnFailure: false });
    expect(results.map((r) => r.verdict)).toEqual(["fail", "pass", "pass"]);
  });

  it("gives each step the outputs of the steps before it", async () => {
    const results = await runSteps(steps, outcome({ a: "pass", b: "pass", c: "pass" }), { stopOnFailure: true });
    expect(results.map((r) => (r.output?.json as { seen: string[] }).seen)).toEqual([[], ["a"], ["a", "b"]]);
  });

  it("turns a thrown error into a failed step", async () => {
    const results = await runSteps(
      steps,
      async (s) => {
        if (s.key === "a") throw new Error("connection refused");
        return { key: s.key, verdict: "pass" };
      },
      { stopOnFailure: true },
    );
    expect(results[0]).toEqual({ key: "a", verdict: "fail", reason: "connection refused" });
    expect(results[1].verdict).toBe("not_run");
  });

  it("stops when cancelled, keeping what it has", async () => {
    let calls = 0;
    const results = await runSteps(
      steps,
      async (s) => {
        calls += 1;
        return { key: s.key, verdict: "pass" };
      },
      { stopOnFailure: false, cancelled: () => calls >= 1 },
    );
    expect(results.map((r) => r.verdict)).toEqual(["pass", "not_run", "not_run"]);
    expect(results[1].reason).toBe("The run was stopped.");
  });

  it("reports progress as each step lands", async () => {
    const seen: number[] = [];
    await runSteps(steps, outcome({ a: "pass", b: "pass", c: "pass" }), {
      stopOnFailure: true,
      onResult: (results) => seen.push(results.length),
    });
    expect(seen).toEqual([1, 2, 3]);
  });

  it("summarises", () => {
    const summary = summariseRun([
      { key: "a", verdict: "pass", ms: 12 },
      { key: "b", verdict: "fail", ms: 30 },
      { key: "c", verdict: "not_run" },
    ]);
    expect(summary).toEqual({ total: 3, passed: 1, failed: 1, notRun: 1, ms: 42 });
    expect(describeRun(summary)).toBe("1 passed · 1 failed · 1 not run · 42 ms");
  });
});

describe("a run in history", () => {
  const request = (id: string, extra: Partial<HistoryEntry> = {}): HistoryEntry => ({
    id,
    at: "2026-09-30T10:00:00.000Z",
    method: "GET",
    path: "/x",
    url: "https://x.test/x",
    status: 200,
    ms: 1,
    bytes: 0,
    specTitle: "Orders",
    operationId: "GET /x",
    headers: {},
    ...extra,
  });

  it("shows a collection run as one row, its steps in order", () => {
    const collection = (index: number, passed: boolean) => ({ id: "c1", name: "Checkout", step: `s${index}`, index, total: 3, passed });
    const rows = historyRows([
      request("r3", { runId: "run1", collection: collection(2, false) }),
      request("single"),
      request("r2", { runId: "run1", collection: collection(1, true) }),
      request("r1", { runId: "run1", collection: collection(0, true) }),
      request("bulk", { runId: "run0" }),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["run", "entry", "entry"]);
    const run = rows[0] as Extract<(typeof rows)[number], { kind: "run" }>;
    expect(run.name).toBe("Checkout");
    expect(run.entries.map((e) => e.id)).toEqual(["r1", "r2", "r3"]);
    expect([run.passed, run.failed]).toEqual([2, 1]);
  });
});

describe("a local mock's warnings", () => {
  it("reads what the mock said was wrong with the request", () => {
    expect(mockWarnings({ "x-spec0-mock-warnings": "body: missing orderId; header Idempotency-Key is required" })).toEqual([
      "body: missing orderId",
      "header Idempotency-Key is required",
    ]);
    expect(mockWarnings({ "content-type": "application/json" })).toEqual([]);
  });
});
