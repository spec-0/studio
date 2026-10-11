import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentApp, AgentRunOptions } from "../agentApp";
import { newCollection, type Collection } from "../collection";
import { DEFAULT_CONNECTION } from "../connection";
import type { LibraryEntry } from "../library";
import type { ToolResult } from "../mcp";
import {
  findCollection,
  maskHeaders,
  maskUrl,
  parseField,
  parseSource,
  parseTarget,
  runAgentTool,
  type AgentToolDeps,
} from "../mcpAgent";
import { redactDeep, setKnownSecrets } from "../redact";
import type { RequestPlan, ResponseResult } from "../request";
import type { RunLog } from "../runLog";

const ORDERS = `openapi: 3.0.3
info: { title: Orders, version: 1.0.0 }
servers: [{ url: "https://orders.example.com/v1" }]
security: [{ apiKey: [] }]
paths:
  /orders:
    post:
      operationId: createOrder
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [sku, quantity]
              properties: { sku: { type: string, example: A-1 }, quantity: { type: integer, example: 1 } }
      responses:
        "201":
          description: created
          content: { application/json: { schema: { $ref: "#/components/schemas/Order" } } }
  /orders/{orderId}:
    parameters:
      - { name: orderId, in: path, required: true, schema: { type: string } }
    get:
      operationId: getOrder
      responses:
        "200": { description: ok, content: { application/json: { schema: { $ref: "#/components/schemas/Order" } } } }
        "404": { description: missing }
    delete:
      operationId: cancelOrder
      responses: { "204": { description: cancelled } }
  /refunds:
    post:
      operationId: refund
      requestBody:
        content:
          application/json:
            schema: { type: object, properties: { orderId: { type: string }, amount: { type: integer } } }
      responses: { "202": { description: accepted } }
components:
  securitySchemes:
    apiKey: { type: apiKey, in: header, name: X-API-Key }
  schemas:
    Order:
      type: object
      required: [id]
      properties: { id: { type: string }, sku: { type: string }, quantity: { type: integer } }
`;

const SECRET = "sk_live_supersecret";

function entry(): LibraryEntry {
  return {
    id: "orders",
    title: "Orders",
    version: "1.0.0",
    source: { kind: "file", ref: "/repo/orders.yaml" },
    operations: 4,
    schemas: 1,
    addedAt: "2026-01-01T00:00:00Z",
    openedAt: "2026-01-01T00:00:00Z",
  } as LibraryEntry;
}

function response(status: number, body: unknown, headers: Record<string, string> = {}): ResponseResult {
  const bodyText = body === undefined ? "" : JSON.stringify(body);
  return { status, statusText: "", headers: { "content-type": "application/json", ...headers }, bodyText, json: body, ms: 3, bytes: bodyText.length };
}

interface World {
  app: AgentApp;
  deps: AgentToolDeps;
  sent: RequestPlan[];
  collections: Collection[];
  runs: Array<{ id: string; options: AgentRunOptions }>;
  history: unknown[];
  specText: { value: string };
}

function world(overrides: Partial<AgentToolDeps> = {}): World {
  const sent: RequestPlan[] = [];
  const runs: World["runs"] = [];
  const history: unknown[] = [];
  const specText = { value: ORDERS };
  let collections: Collection[] = [];
  const running: Record<string, number> = {};
  const app: AgentApp = {
    entries: () => [entry()],
    vars: () => ({ apiKey: SECRET, orderId: "o-1" }),
    environment: () => ({ id: "env", name: "dev" }),
    connection: () => DEFAULT_CONNECTION,
    session: () => null,
    oauthToken: async () => "",
    historyChanged: () => undefined,
    localMocks: {
      running: () => running,
      start: async (e) => (running[e.id] = 4010),
      stop: async (id) => void delete running[id],
    },
    collections: {
      list: () => collections,
      add: (collection) => void (collections = [...collections, collection]),
      change: (id, change) => {
        collections = collections.map((c) => (c.id === id ? change(c) : c));
        return collections.find((c) => c.id === id) ?? null;
      },
      run: async (id, options) => {
        runs.push({ id, options });
        return { runId: "run_1", results: [{ key: "createOrder", verdict: "pass", status: 201, ms: 4 }] };
      },
      runLogs: (): RunLog[] => [],
      saveTo: async (id, path) => {
        collections = collections.map((c) => {
          if (c.id !== id) return c;
          const { draft: _draft, ...kept } = c;
          return { ...kept, file: { path, syncedHash: "x", dirty: false } };
        });
        return [];
      },
    },
  };
  const deps: AgentToolDeps = {
    app: () => app,
    loadLibrary: async () => [entry()],
    readSpecText: async () => specText.value,
    send: async (plan) => {
      sent.push(plan);
      if (plan.method === "POST") return response(201, { id: "o-9", sku: "A-1", quantity: 1 }, { "set-cookie": "session=abc" });
      if (plan.url.endsWith("/orders/missing")) return response(404, undefined);
      return response(200, { id: "o-1", sku: "A-1", quantity: "two" });
    },
    gateRequest: async () => null,
    gateMockStart: async () => null,
    gateSave: async () => null,
    stopGeneration: () => 0,
    recordActivity: () => undefined,
    recordHistory: async (record) => void history.push(record),
    readFile: async () => null,
    rereadFile: async () => specText.value,
    fetchText: async () => specText.value,
    applyUpdate: async () => undefined,
    specChanged: () => undefined,
    ...overrides,
  };
  return {
    app,
    deps,
    sent,
    get collections() {
      return collections;
    },
    runs,
    history,
    specText,
  } as World;
}

const call = (w: World, name: string, args: Record<string, unknown> = {}) =>
  runAgentTool(name, args, w.deps, { agent: "Claude Code" });
const textOf = (result: ToolResult) => result.content.map((part) => part.text).join("\n");
const json = (result: ToolResult) => JSON.parse(result.content[0].text);

beforeEach(() => {
  setKnownSecrets([{ id: "env", name: "dev", variables: [{ name: "apiKey", value: SECRET, secret: true }] }]);
});

describe("send_request", () => {
  it("fills {{variables}}, sends through the gate, checks the response and never returns the secret", async () => {
    const gate = vi.fn(async () => null);
    const w = world({ gateRequest: gate });
    const result = await call(w, "send_request", {
      api: "Orders",
      operation_id: "getOrder",
      path_params: { orderId: "{{orderId}}" },
      auth_value: "{{apiKey}}",
    });
    expect(result.isError).toBeFalsy();
    expect(w.sent[0].url).toBe("https://orders.example.com/v1/orders/o-1");
    expect(w.sent[0].headers["X-API-Key"]).toBe(SECRET);
    expect(gate).toHaveBeenCalledWith("Claude Code", { method: "GET", url: "https://orders.example.com/v1/orders/o-1" });
    const body = json(result);
    expect(body.response.status).toBe(200);
    expect(body.matchesSpec.result).toBe("mismatch");
    expect(body.matchesSpec.findings[0].path).toMatch(/quantity/);
    expect(body.request.headers["X-API-Key"]).toBe("(hidden)");
    // What leaves Studio is redacted once more on the way out.
    expect(JSON.stringify(redactDeep(result))).not.toContain(SECRET);
    expect(w.history).toHaveLength(1);
  });

  it("hides credential headers in the response too", async () => {
    const w = world();
    const result = await call(w, "send_request", { api: "Orders", operation_id: "createOrder", body: { sku: "A-1", quantity: 2 } });
    const body = json(result);
    expect(body.response.status).toBe(201);
    expect(body.response.headers["set-cookie"]).toBe("(hidden)");
    expect(w.sent[0].body).toEqual({ kind: "text", text: JSON.stringify({ sku: "A-1", quantity: 2 }, null, 2) });
  });

  it("goes to a local mock when asked, and says when none is running", async () => {
    const w = world();
    const missing = await call(w, "send_request", { api: "Orders", operation_id: "getOrder", target: "local-mock", path_params: { orderId: "1" } });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toMatch(/start_local_mock/);
    await call(w, "start_local_mock", { api: "Orders" });
    await call(w, "send_request", { api: "Orders", operation_id: "getOrder", target: "local-mock", path_params: { orderId: "1" } });
    expect(w.sent[0].url).toBe("http://127.0.0.1:4010/orders/1");
  });

  it("doesn't send when the developer refuses, and says why", async () => {
    const w = world({ gateRequest: async () => "The user didn't allow it." });
    const result = await call(w, "send_request", { api: "Orders", operation_id: "getOrder", path_params: { orderId: "1" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("The user didn't allow it.");
    expect(w.sent).toEqual([]);
  });

  it("names a variable the environment doesn't have instead of sending it", async () => {
    const w = world();
    const result = await call(w, "send_request", { api: "Orders", operation_id: "getOrder", path_params: { orderId: "{{nope}}" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/\{\{nope\}\}.*dev/);
    expect(w.sent).toEqual([]);
  });

  it("asks for missing path parameters rather than inventing them", async () => {
    const result = await call(world(), "send_request", { api: "Orders", operation_id: "getOrder" });
    expect(textOf(result)).toBe("Pass path_params for orderId.");
  });

  it("sends a request that isn't in any spec, by method and URL", async () => {
    const w = world();
    const result = await call(w, "send_request", { method: "GET", url: "http://localhost:3000/health" });
    expect(result.isError).toBeFalsy();
    expect(json(result).matchesSpec.result).toBe("not_checked");
    expect(w.sent[0].url).toBe("http://localhost:3000/health");
  });
});

describe("check_contract", () => {
  it("runs safe operations with values from the environment and skips the rest, saying why", async () => {
    const w = world();
    const result = json(await call(w, "check_contract", { api: "Orders", target: "http://localhost:8080" }));
    expect(result.target).toBe("http://localhost:8080");
    const byOp = Object.fromEntries(result.results.map((row: { operation: string }) => [row.operation, row]));
    expect(byOp["GET /orders/{orderId}"]).toMatchObject({ result: "mismatch", status: 200 });
    expect(byOp["POST /orders"]).toMatchObject({ result: "skipped" });
    expect(byOp["DELETE /orders/{orderId}"].reason).toMatch(/changes state/);
    expect(w.sent.map((plan) => plan.url)).toEqual(["http://localhost:8080/orders/o-1"]);
  });

  it("stops asking after the developer refuses", async () => {
    const gate = vi.fn(async () => "The user didn't allow it.");
    const w = world({ gateRequest: gate });
    const result = json(await call(w, "check_contract", { api: "Orders", include_mutating: true }));
    expect(gate).toHaveBeenCalledTimes(1);
    expect(result.stopped).toBe("The user didn't allow it.");
    expect(w.sent).toEqual([]);
  });
});

describe("local mocks", () => {
  it("asks before starting one, and lists and stops it", async () => {
    const refused = world({ gateMockStart: async () => "No." });
    expect(textOf(await call(refused, "start_local_mock", { api: "Orders" }))).toBe("No.");

    const w = world();
    expect(json(await call(w, "start_local_mock", { api: "Orders" }))).toMatchObject({ url: "http://127.0.0.1:4010", started: true });
    expect(json(await call(w, "start_local_mock", { api: "Orders" }))).toMatchObject({ started: false });
    expect(json(await call(w, "list_local_mocks")).running).toEqual([{ api: { id: "orders", title: "Orders" }, url: "http://127.0.0.1:4010" }]);
    expect(textOf(await call(w, "stop_local_mock", { api: "Orders" }))).toMatch(/Stopped/);
    expect(json(await call(w, "list_local_mocks")).running).toEqual([]);
  });
});

describe("collections", () => {
  it("builds a draft: steps, a value from an earlier step, an expected status", async () => {
    const w = world();
    const created = json(await call(w, "create_collection", { name: "Checkout" }));
    expect(w.collections[0].draft).toMatchObject({ by: "Claude Code" });

    expect(json(await call(w, "add_step", { collection: created.id, api: "Orders", operation_id: "createOrder", body: { sku: "B-2", quantity: 3 } })).step).toBe("createOrder");
    expect(json(await call(w, "add_step", { collection: "Checkout", api: "Orders", operation_id: "getOrder", key: "readBack" })).step).toBe("readBack");
    await call(w, "add_step", { collection: "Checkout", api: "Orders", operation_id: "refund" });

    const linked = json(await call(w, "link_value", { collection: "Checkout", step: "readBack", field: "path.orderId", from_step: "createOrder", from: "body.id" }));
    expect(linked.value).toBe("{{steps.createOrder.body.id}}");
    expect(w.collections[0].steps[1].pathParams.orderId).toBe("{{steps.createOrder.body.id}}");

    // A number in a JSON body stays a number: the reference goes in without quotes.
    await call(w, "link_value", { collection: "Checkout", step: "refund", field: "body.amount", from_step: "createOrder", from: "body.quantity" });
    await call(w, "link_value", { collection: "Checkout", step: "refund", field: "body.orderId", from_step: "createOrder", from: "body.id" });
    const refundBody = w.collections[0].steps[2].body as string;
    expect(refundBody).toMatch(/"amount": \{\{steps\.createOrder\.body\.quantity\}\}/);
    expect(refundBody).toMatch(/"orderId": "\{\{steps\.createOrder\.body\.id\}\}"/);

    const backwards = await call(w, "link_value", { collection: "Checkout", step: "createOrder", field: "body.sku", from_step: "readBack", from: "body.sku" });
    expect(textOf(backwards)).toMatch(/runs after/);

    expect(textOf(await call(w, "set_expected_status", { collection: "Checkout", step: "readBack", status: "4xx" }))).toBe("readBack now expects any 4xx.");
    expect(w.collections[0].steps[1].expect).toEqual({ status: "4XX" });
    await call(w, "set_expected_status", { collection: "Checkout", step: "readBack", status: "2XX" });
    expect(w.collections[0].steps[1].expect).toBeUndefined();

    await call(w, "update_step", { collection: "Checkout", step: "readBack", headers: { "X-Trace": "1" }, target: "mock" });
    expect(w.collections[0].steps[1]).toMatchObject({ headers: { "X-Trace": "1" }, target: { kind: "mock" } });
    await call(w, "update_step", { collection: "Checkout", step: "readBack", headers: { "X-Trace": null }, target: "server" });
    expect(w.collections[0].steps[1].headers).toEqual({});
    expect(w.collections[0].steps[1].target).toBeUndefined();

    const shown = json(await call(w, "get_collection", { collection: "Checkout" }));
    expect(shown.editable).toBe(true);
    expect(shown.steps[1].usesValues).toEqual([{ field: "path orderId", from: "createOrder.body.id" }]);

    const removed = json(await call(w, "remove_step", { collection: "Checkout", step: "createOrder" }));
    expect(removed.brokenLinks.length).toBe(3);
    expect(w.collections[0].steps.map((step) => step.key)).toEqual(["readBack", "refund"]);
  });

  it("won't change a collection the developer made, but copies it into a draft", async () => {
    const w = world();
    const mine = { ...newCollection("Mine"), id: "col_mine" };
    w.app.collections.add(mine);
    const refused = await call(w, "add_step", { collection: "Mine", api: "Orders", operation_id: "getOrder" });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/isn't a draft/);

    const copy = json(await call(w, "create_collection", { name: "Mine (agent)", copy_of: "Mine" }));
    expect(copy.id).not.toBe("col_mine");
    expect(w.collections.find((c) => c.id === copy.id)?.draft?.by).toBe("Claude Code");
    expect(w.collections.find((c) => c.id === "col_mine")?.draft).toBeUndefined();
  });

  it("runs through the app with the agent's name, its gate and an optional target", async () => {
    const gate = vi.fn(async () => null);
    const w = world({ gateRequest: gate });
    const created = json(await call(w, "create_collection", { name: "Smoke" }));
    await call(w, "add_step", { collection: created.id, api: "Orders", operation_id: "createOrder" });
    const result = json(await call(w, "run_collection", { collection: "Smoke", target: "local-mock" }));
    expect(result).toMatchObject({ runId: "run_1", passed: true, steps: [{ step: "createOrder", result: "pass", status: 201 }] });
    const { options } = w.runs[0];
    expect(options.startedBy).toBe("Claude Code");
    expect(options.target).toEqual({ kind: "local-mock" });
    await options.gate({ method: "POST", url: "http://127.0.0.1:4010/orders", headers: {} });
    expect(gate).toHaveBeenCalledWith("Claude Code", { method: "POST", url: "http://127.0.0.1:4010/orders" });
    expect(options.cancelled()).toBe(false);

    await call(w, "run_collection", { collection: "Smoke", target: "server" });
    expect(w.runs[1].options.target).toBe("first-server");
  });

  it("saves to a file only with approval, adding the suffix, and keeps the draft", async () => {
    const save = vi.fn(async () => null);
    const w = world({ gateSave: save });
    const created = json(await call(w, "create_collection", { name: "Smoke" }));
    const relative = await call(w, "save_collection_to_folder", { collection: created.id, path: "tests/smoke.yaml" });
    expect(textOf(relative)).toMatch(/absolute path/);
    const saved = json(await call(w, "save_collection_to_folder", { collection: created.id, path: "/repo/tests/smoke" }));
    expect(saved.path).toBe("/repo/tests/smoke.spec0-collection.yaml");
    expect(save).toHaveBeenCalledWith("Claude Code", "Smoke", "/repo/tests/smoke.spec0-collection.yaml", false);
    expect(w.collections[0].draft).toBeUndefined();

    const denied = world({ gateSave: async () => "No." });
    const other = json(await call(denied, "create_collection", { name: "Other" }));
    expect(textOf(await call(denied, "save_collection_to_folder", { collection: other.id, path: "/repo/x" }))).toBe("No.");
    expect(denied.collections[0].file).toBeUndefined();
  });

  it("lists collections and finds one by id, name or part of a name", async () => {
    const w = world();
    await call(w, "create_collection", { name: "Checkout flow" });
    expect(json(await call(w, "list_collections")).collections[0]).toMatchObject({ name: "Checkout flow", steps: 0, draft: { by: "Claude Code" } });
    expect(findCollection(w.collections, "checkout").name).toBe("Checkout flow");
    expect(() => findCollection(w.collections, "nothing")).toThrow(/No collection/);
  });
});

describe("specs", () => {
  it("reloads a changed file and says what changed", async () => {
    const w = world();
    const apply = vi.fn(async () => undefined);
    const changed = vi.fn();
    w.deps.applyUpdate = apply;
    w.deps.specChanged = changed;
    w.deps.rereadFile = async () =>
      ORDERS.replace("version: 1.0.0", "version: 1.1.0").replace(
        "  /refunds:",
        "  /orders/{orderId}/ship:\n    post: { operationId: ship, parameters: [{ name: orderId, in: path, required: true, schema: { type: string } }], responses: { \"202\": { description: ok } } }\n  /refunds:",
      );
    const result = json(await call(w, "reload_spec", { api: "Orders" }));
    expect(result.changes.version).toEqual({ before: "1.0.0", after: "1.1.0" });
    expect(result.changes.operationsAdded).toEqual(["POST /orders/{orderId}/ship"]);
    expect(apply).toHaveBeenCalled();
    expect(changed).toHaveBeenCalledWith("orders");
  });

  it("keeps the old version when the file no longer loads", async () => {
    const w = world();
    const apply = vi.fn(async () => undefined);
    w.deps.applyUpdate = apply;
    w.deps.rereadFile = async () => "openapi: 3.0.3\ninfo: [";
    const result = await call(w, "reload_spec", { api: "Orders" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/kept the version it had/);
    expect(apply).not.toHaveBeenCalled();
  });

  it("reports problems in a spec", async () => {
    const w = world();
    w.specText.value = ORDERS.replace("$ref: \"#/components/schemas/Order\" } } } }\n        \"404\"", "$ref: \"#/components/schemas/Nope\" } } } }\n        \"404\"");
    const result = json(await call(w, "validate_spec", { api: "Orders" }));
    expect(result.problems).toContainEqual(expect.objectContaining({ level: "error", message: "#/components/schemas/Nope doesn't point to anything in the document." }));
  });
});

describe("helpers", () => {
  it("reads targets, fields and sources the way the tool descriptions say", () => {
    expect(parseTarget("server")).toBeUndefined();
    expect(parseTarget("mock")).toEqual({ kind: "mock" });
    expect(parseTarget("http://localhost:8080/")).toEqual({ kind: "custom", url: "http://localhost:8080" });
    expect(() => parseTarget("staging")).toThrow(/target must be/);
    expect(parseField("path.orderId")).toEqual({ in: "path", name: "orderId" });
    expect(parseField("headers.X-Id")).toEqual({ in: "header", name: "X-Id" });
    expect(parseField("body.items[0].sku")).toEqual({ in: "body", path: ["items", 0, "sku"] });
    expect(() => parseField("cookie.x")).toThrow(/field must look like/);
    expect(parseSource("status")).toEqual(["status"]);
    expect(parseSource("headers.Location")).toEqual(["headers", "location"]);
    expect(parseSource("body.items[1].id")).toEqual(["body", "items", 1, "id"]);
  });

  it("hides credentials unless they are only references", () => {
    expect(maskHeaders({ Authorization: "Bearer {{token}}", Cookie: "a=b", "X-Other": "x", "X-Key": "k" }, ["X-Key"])).toEqual({
      Authorization: "Bearer {{token}}",
      Cookie: "(hidden)",
      "X-Other": "x",
      "X-Key": "(hidden)",
    });
    expect(maskUrl("https://a.example/x?api_key=abc&q=1", ["api_key"])).toBe("https://a.example/x?api_key=%28hidden%29&q=1");
    expect(maskUrl("https://a.example/x?api_key={{key}}", ["api_key"])).toBe("https://a.example/x?api_key={{key}}");
  });

  it("says Studio isn't ready before the app registers", async () => {
    const w = world({ app: () => null });
    expect(textOf(await call(w, "list_collections"))).toMatch(/isn't ready/);
  });
});
