import { describe, expect, it } from "vitest";
import { parseSpec } from "../spec";
import {
  describeSkip,
  describeSummary,
  isSafeMethod,
  planRun,
  summarise,
  toMarkdown,
  type RunResult,
} from "../runner";

const SPEC = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "orders", version: "1.0.0" },
  paths: {
    "/orders": {
      get: {
        tags: ["orders"],
        operationId: "listOrders",
        parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }],
        responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object" } } } } },
      },
      post: {
        tags: ["orders"],
        operationId: "createOrder",
        responses: { "201": { description: "created" } },
      },
    },
    "/orders/{orderId}": {
      get: {
        tags: ["orders"],
        operationId: "getOrder",
        parameters: [{ name: "orderId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "ok" } },
      },
      delete: {
        tags: ["orders"],
        operationId: "deleteOrder",
        parameters: [{ name: "orderId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "204": { description: "gone" } },
      },
    },
  },
});

const spec = parseSpec(SPEC, "orders.json");
const find = (needle: string) => spec.operations.find((op) => op.id.includes(needle))!;

describe("isSafeMethod", () => {
  it("counts only the methods that change nothing", () => {
    expect(isSafeMethod("get")).toBe(true);
    expect(isSafeMethod("HEAD")).toBe(true);
    expect(isSafeMethod("OPTIONS")).toBe(true);
    expect(isSafeMethod("post")).toBe(false);
    expect(isSafeMethod("DELETE")).toBe(false);
    expect(isSafeMethod("PATCH")).toBe(false);
  });
});

describe("planRun", () => {
  it("skips mutating methods by default, and says which", () => {
    const planned = planRun(spec.operations, { orderId: "o_1" }, { includeMutating: false });
    const post = planned.find((p) => p.operation.method === "POST")!;
    expect(post.skip).toEqual({ kind: "mutating", method: "POST" });
    const get = planned.find((p) => p.operation.id === find("GET /orders").id)!;
    expect(get.skip).toBeNull();
  });

  it("includes mutating methods when asked", () => {
    const planned = planRun(spec.operations, { orderId: "o_1" }, { includeMutating: true });
    expect(planned.find((p) => p.operation.method === "POST")!.skip).toBeNull();
    expect(planned.find((p) => p.operation.method === "DELETE")!.skip).toBeNull();
  });

  it("skips, never invents, an operation whose path parameter has no value", () => {
    // A fabricated {orderId} produces a confident 404 that means nothing. A page
    // of those is worse than a page of honest skips: one looks like a finding.
    const planned = planRun(spec.operations, {}, { includeMutating: false });
    const byId = planned.find((p) => p.operation.path === "/orders/{orderId}" && p.operation.method === "GET")!;
    expect(byId.skip).toEqual({ kind: "missing_params", names: ["orderId"] });
    expect(byId.pathParams).toEqual({});
  });

  it("resolves path parameters from the environment by name", () => {
    const planned = planRun(spec.operations, { orderId: "o_42" }, { includeMutating: false });
    const byId = planned.find((p) => p.operation.path === "/orders/{orderId}" && p.operation.method === "GET")!;
    expect(byId.skip).toBeNull();
    expect(byId.pathParams).toEqual({ orderId: "o_42" });
  });

  it("treats an optional query parameter as optional, not as a reason to skip", () => {
    const planned = planRun(spec.operations, {}, { includeMutating: false });
    const list = planned.find((p) => p.operation.path === "/orders" && p.operation.method === "GET")!;
    expect(list.skip).toBeNull();
    expect(list.queryParams).toEqual({});
  });

  it("reports the mutating skip ahead of missing parameters", () => {
    // Both are true for DELETE /orders/{orderId} with no orderId. "This changes
    // state" is the more useful thing to say first: supplying the id wouldn't
    // make it run.
    const planned = planRun(spec.operations, {}, { includeMutating: false });
    const del = planned.find((p) => p.operation.method === "DELETE")!;
    expect(del.skip).toEqual({ kind: "mutating", method: "DELETE" });
  });
});

describe("describeSkip", () => {
  it("says what to do about it", () => {
    expect(describeSkip({ kind: "mutating", method: "DELETE" })).toContain("enable mutating methods");
    expect(describeSkip({ kind: "missing_params", names: ["orderId"] })).toContain("{{orderId}}");
    expect(describeSkip({ kind: "missing_params", names: ["a", "b"] })).toContain("set them");
  });
});

describe("summarise", () => {
  const results: RunResult[] = [
    { operation: find("GET /orders"), verdict: "ok" },
    { operation: find("GET /orders"), verdict: "mismatch" },
    { operation: find("GET /orders"), verdict: "error" },
    { operation: find("GET /orders"), verdict: "skipped" },
    { operation: find("GET /orders"), verdict: "no_schema" },
  ];

  it("counts each verdict", () => {
    expect(summarise(results)).toEqual({
      total: 5,
      matched: 1,
      mismatched: 1,
      unchecked: 1,
      errored: 1,
      skipped: 1,
    });
  });

  it("reads as a sentence, and stays quiet about categories with nothing in them", () => {
    expect(describeSummary(summarise([{ operation: find("GET /orders"), verdict: "ok" }]))).toBe(
      "1 matched",
    );
    expect(describeSummary(summarise(results))).toBe(
      "1 matched · 1 mismatched · 1 errored · 1 unchecked · 1 skipped",
    );
  });
});

describe("toMarkdown", () => {
  const context = { title: "orders", target: "https://api.example.com", scope: "tag: orders" };

  it("lists skipped operations rather than dropping them", () => {
    // A report that omits what it didn't run reads as "all clear" when it isn't.
    const report = toMarkdown(
      [
        { operation: find("GET /orders"), verdict: "ok", status: 200, ms: 12 },
        {
          operation: find("DELETE"),
          verdict: "skipped",
          skip: { kind: "mutating", method: "DELETE" },
        },
      ],
      context,
    );
    expect(report).toContain("DELETE /orders/{orderId}");
    expect(report).toContain("enable mutating methods");
    expect(report).toContain("1 matched · 1 skipped");
  });

  it("spells out the differences for a mismatch", () => {
    const report = toMarkdown(
      [
        {
          operation: find("GET /orders"),
          verdict: "mismatch",
          status: 200,
          ms: 9,
          validation: {
            status: "mismatch",
            findings: [{ kind: "extra_field", path: "data.extra", message: "not declared" }],
          },
        },
      ],
      context,
    );
    expect(report).toContain("### Differences");
    expect(report).toContain("`data.extra`: not declared");
  });

  it("names the target, so a pasted report says what it ran against", () => {
    const report = toMarkdown([], context);
    expect(report).toContain("https://api.example.com");
    expect(report).toContain("tag: orders");
  });
});
