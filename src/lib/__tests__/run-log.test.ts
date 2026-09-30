/**
 * Collection run logs: the events a run emits, the log built from them, how
 * many are kept, the text and JSON exports, and that no secret gets into any
 * of it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveStepRefs, type StepOutput } from "../chain";
import type { CollectionStep } from "../collection";
import { planStep, runSteps, type RunEvent, type StepDetail, type StepResult } from "../collectionRun";
import { setKnownSecrets } from "../redact";
import {
  addRun,
  appendEvent,
  clearRuns,
  EMPTY_RUN_LOGS,
  keepCollections,
  loadRunLogs,
  MAX_EVENTS_PER_RUN,
  MAX_RUNS_PER_COLLECTION,
  MAX_STORE_CHARS,
  RUN_LOG_STORE,
  runLogFileName,
  runLogJson,
  runLogText,
  saveRunLogs,
  startLog,
  timeline,
  withRunLogSuffix,
  type RunLog,
} from "../runLog";
import { SAMPLE_SPEC } from "../sample";
import { parseSpec } from "../spec";

const spec = parseSpec(SAMPLE_SPEC, "sample");
const op = (id: string) => spec.operations.find((o) => o.operationId === id)!;

const SECRET = "sk_live_supersecret_42";

const step = (key: string, extra: Partial<CollectionStep> = {}): CollectionStep => ({
  key,
  api: "orders",
  operation: { method: "GET", path: "/orders" },
  pathParams: {},
  queryParams: {},
  headers: {},
  ...extra,
});

/** A step's answer from the fake server. */
type Answer = { status: number; json?: unknown } | { network: string };

/**
 * An `execute` that does what the real one does, minus the network: builds the
 * request with `planStep`, reports each stage through `emit`, and decides pass
 * or fail on the status.
 */
function fakeExecute(answers: Record<string, Answer>, vars: Record<string, string>) {
  return async (
    s: CollectionStep,
    outputs: ReadonlyMap<string, StepOutput>,
    _index: number,
    emit: (detail: StepDetail) => void,
  ): Promise<StepResult> => {
    const planned = planStep(s, {
      op: op(s.key === "create" ? "createOrder" : "getOrder"),
      baseUrl: "https://api.example.com/v1",
      vars,
      keys: ["create", "get", "pay"],
      outputs,
      auth: { schemeName: "bearerAuth", type: "http", httpScheme: "bearer", value: "{{token}}" },
    });
    if (planned.links?.length) emit({ type: "references_resolved", links: planned.links });
    if ("error" in planned) return { key: s.key, verdict: "fail", reason: planned.error };
    emit({ type: "request_sent", method: planned.plan.method, url: planned.plan.url, headers: planned.plan.headers, targetKind: "server" });
    const answer = answers[s.key];
    if ("network" in answer) {
      emit({ type: "request_failed", error: answer.network });
      return { key: s.key, verdict: "fail", reason: answer.network };
    }
    emit({ type: "response_received", status: answer.status, ms: 12, bytes: 40 });
    const ok = answer.status < 300;
    emit({ type: "status_check", expected: "2xx", actual: answer.status, ok });
    emit({ type: "schema_check", result: "ok", findings: 0 });
    return {
      key: s.key,
      verdict: ok ? "pass" : "fail",
      ...(ok ? {} : { reason: `The server answered ${answer.status}.` }),
      status: answer.status,
      ms: 12,
      output: { status: answer.status, headers: {}, json: answer.json, text: JSON.stringify(answer.json ?? null) },
    };
  };
}

const steps = [
  step("create", { operation: { method: "POST", path: "/orders" } }),
  step("get", { pathParams: { orderId: "{{steps.create.body.id}}" } }),
  step("pay", { pathParams: { orderId: "{{steps.create.body.id}}" } }),
];

/** Run with a clock that moves 5 ms per reading. */
async function run(
  answers: Record<string, Answer>,
  options: { stopOnFailure?: boolean; cancelled?: () => boolean; vars?: Record<string, string>; list?: CollectionStep[] } = {},
) {
  const events: RunEvent[] = [];
  let clock = Date.parse("2026-09-30T10:00:00.000Z");
  const results = await runSteps(options.list ?? steps, fakeExecute(answers, options.vars ?? { token: SECRET }), {
    stopOnFailure: options.stopOnFailure ?? true,
    cancelled: options.cancelled,
    onEvent: (event) => events.push(event),
    run: { collection: { id: "c1", name: "Checkout" }, environment: "Staging", targets: ["https://api.example.com/v1"] },
    describe: (s) => ({ name: s.key, method: s.operation?.method, target: "https://api.example.com/v1", targetKind: "server" }),
    now: () => (clock += 5),
  });
  return { events, results };
}

const types = (events: RunEvent[]) => events.map((e) => ("index" in e ? `${e.type}:${e.index}` : e.type));

const created = { status: 201, json: { id: "o_1" } };

afterEach(() => setKnownSecrets([]));

describe("the events a run emits", () => {
  it("tells a passing run in order, with times", async () => {
    const { events } = await run({ create: created, get: { status: 200, json: {} }, pay: { status: 200, json: {} } });
    expect(types(events)).toEqual([
      "run_started",
      "step_started:0",
      "request_sent:0",
      "response_received:0",
      "status_check:0",
      "schema_check:0",
      "step_result:0",
      "step_started:1",
      "references_resolved:1",
      "request_sent:1",
      "response_received:1",
      "status_check:1",
      "schema_check:1",
      "step_result:1",
      "step_started:2",
      "references_resolved:2",
      "request_sent:2",
      "response_received:2",
      "status_check:2",
      "schema_check:2",
      "step_result:2",
      "run_finished",
    ]);
    expect(events[0]).toMatchObject({
      type: "run_started",
      collection: { id: "c1", name: "Checkout" },
      environment: "Staging",
      steps: 3,
      targets: ["https://api.example.com/v1"],
      t: 0,
      at: "2026-09-30T10:00:00.005Z",
    });
    // Relative times only go up.
    const times = events.map((e) => e.t);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(events.at(-1)).toMatchObject({ type: "run_finished", total: 3, passed: 3, failed: 0, skipped: 0, stoppedEarly: false });
  });

  it("shows which value was passed from which step", async () => {
    const { events } = await run({ create: created, get: { status: 200, json: {} }, pay: { status: 200, json: {} } });
    const links = events.find((e) => e.type === "references_resolved" && e.index === 1);
    expect(links).toMatchObject({
      links: [{ target: "path orderId", source: "steps.create.body.id", value: "o_1" }],
    });
    const sent = events.find((e) => e.type === "request_sent" && e.index === 1);
    expect(sent).toMatchObject({ method: "GET", url: "https://api.example.com/v1/orders/o_1" });
  });

  it("says why a step failed, and stops early with the rest skipped", async () => {
    const { events } = await run({ create: created, get: { status: 500, json: {} }, pay: { status: 200 } });
    const results = events.filter((e) => e.type === "step_result");
    expect(results.map((e) => e.type === "step_result" && [e.verdict, e.cause])).toEqual([
      ["pass", undefined],
      ["fail", "status"],
      ["skipped", "earlier_failure"],
    ]);
    expect(results[2]).toMatchObject({ reason: expect.stringMatching(/step 2 \(get\) failed/) });
    expect(types(events).filter((t) => t.endsWith(":2"))).toEqual(["step_result:2"]);
    expect(events.at(-1)).toMatchObject({
      type: "run_finished",
      passed: 1,
      failed: 1,
      skipped: 1,
      stoppedEarly: true,
      stopReason: "earlier_failure",
    });
  });

  it("names a network error as the cause", async () => {
    const { events } = await run({ create: { network: "Couldn't connect to api.example.com" }, get: created, pay: created }, { stopOnFailure: false });
    expect(events.find((e) => e.type === "request_failed")).toMatchObject({ index: 0, error: expect.stringMatching(/connect/) });
    expect(events.find((e) => e.type === "step_result" && e.index === 0)).toMatchObject({ verdict: "fail", cause: "network" });
  });

  it("names an unresolved reference as the cause, and sends nothing for that step", async () => {
    // create fails over the network, so get has no value to use.
    const { events } = await run({ create: { network: "refused" }, get: created, pay: created }, { stopOnFailure: false });
    const get = events.filter((e) => "index" in e && e.index === 1);
    expect(get.map((e) => e.type)).toEqual(["step_started", "references_resolved", "step_result"]);
    expect(get[1]).toMatchObject({
      links: [{ target: "path orderId", source: "steps.create.body.id", error: expect.stringMatching(/hasn't run yet/) }],
    });
    expect(get[2]).toMatchObject({ verdict: "fail", cause: "reference" });
  });

  it("names a missing environment value as an unresolved value too", async () => {
    const { events } = await run({ create: created, get: created, pay: created }, { vars: {}, stopOnFailure: true });
    expect(events.find((e) => e.type === "references_resolved")).toMatchObject({
      links: [{ source: "env.token", error: "no value in the active environment" }],
    });
    expect(events.find((e) => e.type === "step_result")).toMatchObject({ verdict: "fail", cause: "reference" });
  });

  it("marks steps after a stop as skipped by the user", async () => {
    let calls = 0;
    const { events } = await run(
      { create: created, get: created, pay: created },
      { stopOnFailure: false, cancelled: () => calls++ >= 1 },
    );
    expect(events.filter((e) => e.type === "step_result").map((e) => e.type === "step_result" && e.cause)).toEqual([
      undefined,
      "stopped",
      "stopped",
    ]);
    expect(events.at(-1)).toMatchObject({ stoppedEarly: true, stopReason: "stopped" });
  });

  it("calls a thrown error an error", async () => {
    const events: RunEvent[] = [];
    await runSteps([step("a")], async () => Promise.reject(new Error("boom")), {
      stopOnFailure: true,
      onEvent: (e) => events.push(e),
    });
    expect(events.find((e) => e.type === "step_result")).toMatchObject({ verdict: "fail", cause: "error", reason: "boom" });
    // No `run` given: no run_started, but still a run_finished.
    expect(events[0].type).toBe("step_started");
    expect(events.at(-1)?.type).toBe("run_finished");
  });

  it("works for callers that don't listen", async () => {
    const { results } = await run({ create: created, get: created, pay: created });
    expect(results.map((r) => r.verdict)).toEqual(["pass", "pass", "pass"]);
    const quiet = await runSteps(steps, fakeExecute({ create: created, get: created, pay: created }, { token: "x" }), {
      stopOnFailure: true,
    });
    expect(quiet).toHaveLength(3);
  });
});

describe("the resolver's links", () => {
  it("lists every reference, resolved or not, with where it went", () => {
    const outputs = new Map<string, StepOutput>([["a", { status: 201, headers: { Location: "/x" }, json: { id: 7 }, text: "" }]]);
    const { links } = resolveStepRefs("{{steps.a.body.id}}/{{steps.a.headers.location}}/{{steps.zz.body}}", { keys: ["a"], outputs }, "url");
    expect(links).toEqual([
      { target: "url", source: "steps.a.body.id", value: "7" },
      { target: "url", source: "steps.a.headers.location", value: "/x" },
      { target: "url", source: "steps.zz.body", error: expect.stringMatching(/no step called "zz"/) },
    ]);
    expect(resolveStepRefs("plain", { keys: [], outputs }).links).toEqual([]);
  });
});

// Logs

async function logOf(answers: Record<string, Answer>, options: Parameters<typeof run>[1] = {}, id = "run_1"): Promise<RunLog> {
  const { events } = await run(answers, options);
  return events.reduce((log, event) => appendEvent(log, event), startLog(id, { id: "c1", name: "Checkout" }, "Staging", events[0].at));
}

describe("a run's log", () => {
  it("puts each step together from its events", async () => {
    const log = await logOf({ create: created, get: { status: 404, json: {} }, pay: created });
    expect(log.counts).toEqual({ total: 3, passed: 1, failed: 1, skipped: 1 });
    expect(log.stoppedEarly).toBe(true);
    const [first, second, third] = timeline(log);
    expect(first).toMatchObject({ verdict: "pass", method: "POST", status: 201, ms: 12, targetKind: "server" });
    expect(second).toMatchObject({
      verdict: "fail",
      cause: "status",
      url: "https://api.example.com/v1/orders/o_1",
      links: [{ source: "steps.create.body.id", value: "o_1" }],
      expected: { expected: "2xx", actual: 404, ok: false },
    });
    expect(third).toMatchObject({ verdict: "skipped", cause: "earlier_failure" });
    expect(third.t).toBeGreaterThan(second.t!);
  });

  it("keeps at most so many events, and says so", () => {
    let log = startLog("r", { id: "c", name: "C" }, null, "2026-09-30T10:00:00.000Z");
    const event = (t: number): RunEvent => ({ type: "step_started", index: t, key: `s${t}`, name: `s${t}`, at: "2026-09-30T10:00:00.000Z", t });
    for (let i = 0; i < MAX_EVENTS_PER_RUN + 5; i += 1) log = appendEvent(log, event(i));
    expect(log.events).toHaveLength(MAX_EVENTS_PER_RUN);
    expect(log.truncated).toBe(true);
    log = appendEvent(log, { type: "run_finished", total: 1, passed: 1, failed: 0, skipped: 0, ms: 3, stoppedEarly: false, at: "x", t: 3 });
    expect(log.events.at(-1)?.type).toBe("run_finished");
  });

  it("reads as text: time, step, what happened and why", async () => {
    const log = await logOf({ create: created, get: { status: 500, json: {} }, pay: created });
    const text = runLogText(log);
    expect(text).toContain("Checkout: run");
    expect(text).toContain("Environment: Staging");
    expect(text).toContain("Result: 1 passed · 1 failed · 1 skipped");
    expect(text).toMatch(/\+\d+ ms\s+2\. get {2}FAIL/);
    expect(text).toContain("path orderId ← steps.create.body.id = o_1");
    expect(text).toContain("Unexpected status: The server answered 500.");
    expect(text).toMatch(/3\. pay {2}SKIPPED/);
    expect(text).toContain("An earlier step failed:");
  });

  it("exports as JSON with a format marker and every event", async () => {
    const log = await logOf({ create: created, get: created, pay: created });
    const parsed = JSON.parse(runLogJson(log));
    expect(parsed).toMatchObject({ format: "spec0-studio-run-log", formatVersion: 1, id: "run_1", collection: { name: "Checkout" } });
    expect(parsed.events).toHaveLength(log.events.length);
    expect(parsed.events[0]).toHaveProperty("at");
    expect(parsed.events[0]).toHaveProperty("t");
  });

  it("names exported files so only Studio's own suffix is written", () => {
    const log = startLog("r", { id: "c", name: "Checkout / EU" }, null, "2026-09-30T10:00:00.123Z");
    expect(runLogFileName(log, "json")).toBe("Checkout-EU-2026-09-30T10-00-00Z.spec0-run.json");
    expect(withRunLogSuffix("/tmp/run.json", "json")).toBe("/tmp/run.spec0-run.json");
    expect(withRunLogSuffix("/tmp/a.spec0-run.txt", "txt")).toBe("/tmp/a.spec0-run.txt");
    expect(withRunLogSuffix("/tmp/a.spec0-run.txt", "json")).toBe("/tmp/a.spec0-run.json");
  });
});

describe("keeping past runs", () => {
  const tiny = (id: string, collection = "c1", at = `2026-09-30T10:00:${id.padStart(2, "0")}.000Z`): RunLog => ({
    ...startLog(id, { id: collection, name: collection }, null, at),
    events: [],
  });

  it("keeps the newest runs per collection, newest first", () => {
    let store = EMPTY_RUN_LOGS;
    for (let i = 0; i < MAX_RUNS_PER_COLLECTION + 5; i += 1) store = addRun(store, tiny(String(i)));
    expect(store.runs.c1).toHaveLength(MAX_RUNS_PER_COLLECTION);
    expect(store.runs.c1[0].id).toBe(String(MAX_RUNS_PER_COLLECTION + 4));
  });

  it("drops the oldest runs anywhere when the file gets too big", () => {
    const big = (id: string, collection: string, at: string): RunLog => ({
      ...tiny(id, collection, at),
      events: [{ type: "run_finished", total: 0, passed: 0, failed: 0, skipped: 0, ms: 0, stoppedEarly: false, at, t: 0, pad: "x".repeat(MAX_STORE_CHARS / 3) } as unknown as RunEvent],
    });
    let store = addRun(EMPTY_RUN_LOGS, big("old", "a", "2026-01-01T00:00:00.000Z"));
    store = addRun(store, big("mid", "b", "2026-02-01T00:00:00.000Z"));
    store = addRun(store, big("new", "a", "2026-03-01T00:00:00.000Z"));
    store = addRun(store, big("newest", "b", "2026-04-01T00:00:00.000Z"));
    expect(JSON.stringify(store).length).toBeLessThanOrEqual(MAX_STORE_CHARS);
    const ids = Object.values(store.runs).flat().map((r) => r.id);
    expect(ids).toContain("newest");
    expect(ids).not.toContain("old");
  });

  it("keeps only the outline of a single run too big for the file", () => {
    const huge: RunLog = {
      ...tiny("h"),
      events: [
        { type: "step_started", index: 0, key: "a", name: "a", at: "x", t: 0, url: "y".repeat(MAX_STORE_CHARS) } as RunEvent,
        { type: "step_result", index: 0, key: "a", name: "a", verdict: "pass", at: "x", t: 1 },
      ],
    };
    const store = addRun(EMPTY_RUN_LOGS, huge);
    expect(store.runs.c1[0].events.map((e) => e.type)).toEqual(["step_result"]);
    expect(store.runs.c1[0].truncated).toBe(true);
  });

  it("clears one collection's runs, and forgets deleted collections", () => {
    let store = addRun(addRun(EMPTY_RUN_LOGS, tiny("1", "a")), tiny("2", "b"));
    expect(Object.keys(clearRuns(store, "a").runs)).toEqual(["b"]);
    store = keepCollections(store, new Set(["b"]));
    expect(Object.keys(store.runs)).toEqual(["b"]);
    expect(keepCollections(store, new Set(["b"]))).toBe(store);
  });

  describe("on disk", () => {
    let disk: Record<string, string>;
    beforeEach(() => {
      disk = {};
      vi.stubGlobal("window", {
        localStorage: {
          getItem: (key: string) => disk[key] ?? null,
          setItem: (key: string, value: string) => {
            disk[key] = value;
          },
          removeItem: (key: string) => {
            delete disk[key];
          },
        },
      });
    });
    afterEach(() => vi.unstubAllGlobals());

    it("round-trips, and ignores anything malformed", async () => {
      await saveRunLogs(addRun(EMPTY_RUN_LOGS, tiny("1")));
      expect((await loadRunLogs()).runs.c1.map((r) => r.id)).toEqual(["1"]);
      disk[`studio:${RUN_LOG_STORE}`] = JSON.stringify({ runs: { c1: [{ nope: true }, tiny("2")], c2: "junk" } });
      const loaded = await loadRunLogs();
      expect(loaded.runs.c1.map((r) => r.id)).toEqual(["2"]);
      expect(loaded.runs.c2).toBeUndefined();
    });
  });
});

// Secrets

describe("secret values never reach a run log", () => {
  const withSecret = () =>
    setKnownSecrets([{ id: "e", name: "Staging", variables: [{ name: "token", value: SECRET, secret: true }] }]);

  it("redacts events as they are emitted: headers, URLs, values passed between steps", async () => {
    withSecret();
    // The server echoes the secret back as the order id, so the next step's URL and link carry it.
    const { events } = await run({ create: { status: 201, json: { id: SECRET } }, get: created, pay: created });
    const text = JSON.stringify(events);
    expect(text).not.toContain(SECRET);
    expect(text).toContain("Bearer {{token}}");
    expect(events.find((e) => e.type === "references_resolved")).toMatchObject({ links: [{ value: "{{token}}" }] });
  });

  it("catches a secret added after the run, in the store, the text and the JSON", async () => {
    // Recorded before the secret was known: the raw value is in the events.
    const log = await logOf({ create: { status: 201, json: { id: SECRET } }, get: created, pay: created });
    expect(JSON.stringify(log)).toContain(SECRET);
    withSecret();
    expect(JSON.stringify(addRun(EMPTY_RUN_LOGS, log))).not.toContain(SECRET);
    expect(runLogText(log)).not.toContain(SECRET);
    expect(runLogJson(log)).not.toContain(SECRET);
    expect(runLogJson(log)).toContain("{{token}}");
  });

  it("redacts a Basic credential in the request headers", async () => {
    withSecret();
    const events: RunEvent[] = [];
    await runSteps(
      [step("a")],
      async (s, _o, _i, emit) => {
        emit({ type: "request_sent", method: "GET", url: "https://x", headers: { Authorization: `Basic ${btoa(`me:${SECRET}`)}` } });
        return { key: s.key, verdict: "pass" };
      },
      { stopOnFailure: true, onEvent: (e) => events.push(e) },
    );
    expect(events.find((e) => e.type === "request_sent")).toMatchObject({ headers: { Authorization: "Basic me:{{token}}" } });
  });
});
