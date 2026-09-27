import { describe, expect, it, vi } from "vitest";
import type { LibraryEntry } from "../library";
import {
  expandSchema,
  findApi,
  MCP_TOOLS,
  runTool,
  scoreOperation,
  serverUrls,
  SIGN_IN_MESSAGE,
  SPEC_PAGE_CHARS,
  type ToolDeps,
  type ToolResult,
} from "../mcp";
import {
  DEFAULT_MCP_PORT,
  loadMcpPrefs,
  maskToken,
  newToken,
  setupSnippets,
} from "../mcpServer";
import { parseSpec } from "../spec";
import { Spec0Error, type Session } from "../spec0";

const ORDERS = `openapi: 3.0.3
info: { title: Orders, version: 1.2.0 }
servers:
  - url: https://{region}.orders.example.com/v1
    variables: { region: { default: eu } }
security: [{ apiKey: [] }]
paths:
  /orders:
    get:
      operationId: listOrders
      summary: List orders
      tags: [orders]
      responses:
        "200":
          description: ok
          content: { application/json: { schema: { type: array, items: { $ref: "#/components/schemas/Order" } } } }
  /orders/{orderId}:
    parameters:
      - { name: orderId, in: path, required: true, schema: { type: string } }
    get:
      operationId: getOrder
      summary: Get an order
      responses:
        "200": { description: ok, content: { application/json: { schema: { $ref: "#/components/schemas/Order" } } } }
    delete:
      operationId: cancelOrder
      summary: Cancel an order
      responses: { "204": { description: cancelled } }
components:
  securitySchemes:
    apiKey: { type: apiKey, in: header, name: X-API-Key }
  schemas:
    Order:
      type: object
      properties:
        id: { type: string }
        parent: { $ref: "#/components/schemas/Order" }
        lines: { type: array, items: { $ref: "#/components/schemas/Line" } }
    Line:
      type: object
      properties: { sku: { type: string } }
`;

const PETS = `openapi: 3.0.3
info: { title: Pets, version: "2" }
servers: [{ url: /api }]
paths:
  /pets:
    get: { operationId: listPets, summary: List pets, responses: { "200": { description: ok } } }
`;

function entry(id: string, title: string, extra: Partial<LibraryEntry> = {}): LibraryEntry {
  return {
    id,
    title,
    version: "1.2.0",
    source: { kind: "file", ref: `/specs/${id}.yaml` },
    operations: 3,
    schemas: 2,
    addedAt: "2026-01-01T00:00:00Z",
    openedAt: "2026-01-01T00:00:00Z",
    ...extra,
  };
}

const SESSION: Session = {
  apiUrl: "https://api.example.com",
  appUrl: "https://app.example.com",
  orgId: "org-1",
  orgName: "Example Org",
  token: "SESSION_TOKEN_must_never_leak",
  source: "manual",
  connectedAt: "2026-01-01T00:00:00Z",
};

function makeDeps(overrides: Partial<ToolDeps> = {}, entries?: LibraryEntry[]): ToolDeps {
  const library = entries ?? [
    entry("file_orders", "Orders"),
    entry("url_pets", "Pets", { source: { kind: "url", ref: "https://pets.example.com/openapi.yaml" }, operations: 1 }),
  ];
  const texts: Record<string, string> = { file_orders: ORDERS, url_pets: PETS, spec0_orders: ORDERS };
  return {
    loadLibrary: async () => library,
    readSpecText: async (id) => texts[id] ?? null,
    loadSession: async () => null,
    studioVersion: async () => "0.2.0",
    listTeamApis: async () => [],
    listMocks: async () => [],
    createMock: vi.fn(),
    refreshMock: vi.fn(),
    setMock: vi.fn(async () => []),
    libraryChanged: vi.fn(),
    ...overrides,
  };
}

const output = (result: ToolResult) => result.content.map((part) => part.text).join("\n");
const json = (result: ToolResult) => JSON.parse(result.content[result.content.length - 1].text);

describe("tool definitions", () => {
  it("lists every tool, and marks the mock tools as needing sign-in", () => {
    expect(MCP_TOOLS.map((tool) => tool.name)).toEqual([
      "list_local_apis",
      "get_api_spec",
      "get_operation",
      "search_operations",
      "get_connection_status",
      "list_environments",
      "get_mock_server",
      "create_mock_server",
      "refresh_mock_server",
    ]);
    const signedIn = MCP_TOOLS.filter((tool) => tool.requiresSignIn).map((tool) => tool.name);
    expect(signedIn).toEqual(["get_mock_server", "create_mock_server", "refresh_mock_server"]);
    for (const tool of MCP_TOOLS.filter((row) => row.requiresSignIn)) {
      expect(tool.description).toMatch(/signed in to Spec0/);
    }
  });

  it("has no tool that sends requests to an API", () => {
    expect(MCP_TOOLS.some((tool) => /send|request|call_api|fetch/.test(tool.name))).toBe(false);
  });
});

describe("helpers", () => {
  const entries = [entry("a", "Orders"), entry("b", "Orders Admin"), entry("c", "Pets")];

  it("finds an API by id, exact title, or a unique part of the title", () => {
    expect(findApi(entries, "c").id).toBe("c");
    expect(findApi(entries, "orders").id).toBe("a");
    expect(findApi(entries, "admin").id).toBe("b");
    expect(() => findApi(entries, "ord")).toThrow(/More than one/);
    expect(() => findApi(entries, "nope")).toThrow(/list_local_apis/);
  });

  it("fills server variables and resolves relative servers", () => {
    const orders = parseSpec(ORDERS, "Orders");
    expect(serverUrls(orders.doc)).toEqual(["https://eu.orders.example.com/v1"]);
    const pets = parseSpec(PETS, "Pets");
    expect(serverUrls(pets.doc, "https://pets.example.com/openapi.yaml")).toEqual(["https://pets.example.com/api"]);
    expect(serverUrls(pets.doc)).toEqual(["/api"]);
  });

  it("expands references without looping on cycles", () => {
    const doc = parseSpec(ORDERS, "Orders").doc;
    const expanded = expandSchema(doc, { $ref: "#/components/schemas/Order" }, 4) as Record<string, any>;
    expect(expanded["x-schema-name"]).toBe("Order");
    expect(expanded.properties.parent).toEqual({ $ref: "#/components/schemas/Order", circular: true });
    expect(expanded.properties.lines.items.properties.sku.type).toBe("string");
    const shallow = expandSchema(doc, { $ref: "#/components/schemas/Order" }, 0);
    expect(shallow).toEqual({ $ref: "#/components/schemas/Order" });
  });

  it("scores plurals, camelCase ids and paths", () => {
    const ops = parseSpec(ORDERS, "Orders").operations;
    const cancel = ops.find((op) => op.operationId === "cancelOrder")!;
    const list = ops.find((op) => op.operationId === "listOrders")!;
    expect(scoreOperation(cancel, "cancel orders")).toBeGreaterThan(scoreOperation(list, "cancel orders"));
    expect(scoreOperation(list, "zebra")).toBe(0);
  });
});

describe("always-available tools", () => {
  it("list_local_apis reports sources, counts, base URLs and mocks", async () => {
    const deps = makeDeps({}, [
      entry("file_orders", "Orders", { mockUrl: "https://api.example.com/mock/orders" }),
      entry("url_pets", "Pets", { source: { kind: "url", ref: "https://pets.example.com/openapi.yaml" } }),
    ]);
    const result = json(await runTool("list_local_apis", {}, deps));
    expect(result.count).toBe(2);
    expect(result.apis[0]).toMatchObject({
      id: "file_orders",
      source: { kind: "file" },
      baseUrls: ["https://eu.orders.example.com/v1"],
      hasMock: true,
    });
    expect(result.apis[1]).toMatchObject({ baseUrls: ["https://pets.example.com/api"], hasMock: false });
  });

  it("get_api_spec returns the document, in parts when it's large", async () => {
    const small = await runTool("get_api_spec", { api: "Orders" }, makeDeps());
    expect(small.isError).toBeUndefined();
    expect(small.content[0].text).toMatch(/complete/);
    expect(small.content[1].text).toBe(ORDERS);

    const big = "openapi: 3.0.0\n" + "#".repeat(SPEC_PAGE_CHARS * 2);
    const deps = makeDeps({ readSpecText: async () => big });
    const first = await runTool("get_api_spec", { api: "Orders" }, deps);
    expect(first.content[0].text).toMatch(`offset=${SPEC_PAGE_CHARS}`);
    expect(first.content[1].text.length).toBe(SPEC_PAGE_CHARS);
    const last = await runTool("get_api_spec", { api: "Orders", offset: SPEC_PAGE_CHARS * 2 }, deps);
    expect(last.content[0].text).toMatch(/last part/);
    const past = await runTool("get_api_spec", { api: "Orders", offset: big.length + 5 }, deps);
    expect(past.isError).toBe(true);
  });

  it("get_operation finds by operationId or by method and a concrete path", async () => {
    const byId = json(await runTool("get_operation", { api: "Orders", operation_id: "getOrder" }, makeDeps()));
    expect(byId.method).toBe("GET");
    expect(byId.urls).toEqual([
      { server: "https://eu.orders.example.com/v1", url: "https://eu.orders.example.com/v1/orders/{orderId}" },
    ]);
    expect(byId.parameters[0]).toMatchObject({ name: "orderId", in: "path", required: true });
    expect(byId.responses[0].schema["x-schema-name"]).toBe("Order");
    expect(byId.security).toEqual([
      expect.objectContaining({ name: "apiKey", type: "apiKey", in: "header", parameterName: "X-API-Key" }),
    ]);

    const byPath = json(
      await runTool("get_operation", { api: "Orders", method: "delete", path: "/orders/42" }, makeDeps()),
    );
    expect(byPath.operationId).toBe("cancelOrder");

    const missing = await runTool("get_operation", { api: "Orders", operation_id: "listOrder" }, makeDeps());
    expect(missing.isError).toBe(true);
    expect(output(missing)).toMatch(/listOrders/);

    const nothing = await runTool("get_operation", { api: "Orders" }, makeDeps());
    expect(output(nothing)).toMatch(/operation_id, or both method and path/);
  });

  it("search_operations searches every API, best first", async () => {
    const result = json(await runTool("search_operations", { query: "cancel order" }, makeDeps()));
    expect(result.results[0]).toMatchObject({ api: "Orders", operationId: "cancelOrder" });
    const pets = json(await runTool("search_operations", { query: "pets" }, makeDeps()));
    expect(pets.results.map((row: any) => row.api)).toEqual(["Pets"]);
    const none = json(await runTool("search_operations", { query: "invoices" }, makeDeps()));
    expect(none.note).toMatch(/remote Spec0 MCP server/);
  });

  it("get_connection_status says local or signed in, and never the token", async () => {
    const local = json(await runTool("get_connection_status", {}, makeDeps()));
    expect(local).toMatchObject({ mode: "local", signedInToolsAvailable: false, studioVersion: "0.2.0" });
    const signedIn = await runTool("get_connection_status", {}, makeDeps({ loadSession: async () => SESSION }));
    expect(json(signedIn)).toMatchObject({
      mode: "signed-in",
      organisation: "Example Org",
      spec0AppUrl: "https://app.example.com",
      remoteSpec0McpServer: "https://api.example.com/mcp",
    });
    expect(output(signedIn)).not.toContain(SESSION.token);
  });

  it("an unknown tool or a bad argument is a readable error", async () => {
    expect((await runTool("list_environments", {}, makeDeps())).isError).toBe(true);
    expect((await runTool("nope", {}, makeDeps())).isError).toBe(true);
    expect(output(await runTool("get_api_spec", {}, makeDeps()))).toMatch(/Say which API/);
  });
});

describe("signed-in tools", () => {
  it("say to sign in when signed out, without calling Spec0", async () => {
    const deps = makeDeps();
    for (const name of ["get_mock_server", "create_mock_server", "refresh_mock_server"]) {
      const result = await runTool(name, { api: "Orders" }, deps);
      expect(result.isError).toBe(true);
      expect(output(result)).toBe(SIGN_IN_MESSAGE);
    }
    expect(deps.createMock).not.toHaveBeenCalled();
    expect(deps.refreshMock).not.toHaveBeenCalled();
  });

  it("get_mock_server returns the URL, key, header and a curl command", async () => {
    const deps = makeDeps(
      {
        loadSession: async () => SESSION,
        listMocks: async () => [
          { mockServerId: "m1", apiId: "api-1", mockBaseUrl: "/mock/orders", specVersion: "1.1.0" },
        ],
      },
      [entry("spec0_orders", "Orders", { source: { kind: "spec0", ref: "spec0:api-1" }, mockServerId: "m1", mockApiKey: "mk_123" })],
    );
    const result = await runTool("get_mock_server", { api: "Orders" }, deps);
    const body = json(result);
    expect(body).toMatchObject({
      mockUrl: "https://api.example.com/mock/orders",
      apiKey: "mk_123",
      authentication: { header: "X-Mock-API-Key", value: "mk_123" },
      mockSpecVersion: "1.1.0",
    });
    expect(body.versionNote).toMatch(/1\.1\.0/);
    expect(body.curl).toBe(
      "curl --globoff -H 'X-Mock-API-Key: mk_123' 'https://api.example.com/mock/orders/orders'",
    );
    expect(output(result)).not.toContain(SESSION.token);
  });

  it("get_mock_server says plainly when Studio has no key", async () => {
    const deps = makeDeps({ loadSession: async () => SESSION }, [
      entry("file_orders", "Orders", { mockUrl: "https://api.example.com/mock/orders" }),
    ]);
    const body = json(await runTool("get_mock_server", { api: "Orders" }, deps));
    expect(body.apiKey).toBeNull();
    expect(body.note).toMatch(/dashboard/);
  });

  it("create_mock_server refuses an API that isn't published, and says how to publish", async () => {
    const deps = makeDeps({ loadSession: async () => SESSION });
    const result = await runTool("create_mock_server", { api: "Orders" }, deps);
    expect(output(result)).toMatch(/isn't published to Spec0 yet/);
    expect(output(result)).toMatch(/Publish/);
    expect(deps.createMock).not.toHaveBeenCalled();
  });

  it("create_mock_server creates, stores the key, and tells the interface", async () => {
    const createMock = vi.fn(async () => ({
      mockServerId: "m9",
      mockUrl: "https://api.example.com/mock/orders",
      created: true,
      apiKey: "mk_new",
    }));
    const deps = makeDeps({
      loadSession: async () => SESSION,
      listTeamApis: async () => [{ apiId: "api-7", apiName: "orders" }],
      createMock,
    });
    const body = json(await runTool("create_mock_server", { api: "Orders" }, deps));
    expect(createMock).toHaveBeenCalledWith(SESSION, "api-7");
    expect(body).toMatchObject({ created: true, apiKey: "mk_new", spec0Api: "orders" });
    expect(deps.setMock).toHaveBeenCalledWith("file_orders", {
      mockUrl: "https://api.example.com/mock/orders",
      mockApiKey: "mk_new",
      mockServerId: "m9",
    });
    expect(deps.libraryChanged).toHaveBeenCalled();
  });

  it("create_mock_server passes the server's refusal through as written", async () => {
    const said = "You have reached the limit for this account.";
    const deps = makeDeps(
      {
        loadSession: async () => SESSION,
        createMock: async () => {
          throw new Spec0Error("x", 403, "u", JSON.stringify({ detail: said }));
        },
      },
      [entry("spec0_orders", "Orders", { source: { kind: "spec0", ref: "spec0:api-1" } })],
    );
    const result = await runTool("create_mock_server", { api: "Orders" }, deps);
    expect(result.isError).toBe(true);
    expect(output(result)).toBe(`Spec0 couldn't create the mock (HTTP 403). It said: ${said}`);
  });

  it("refresh_mock_server rebuilds and records the version", async () => {
    const refreshMock = vi.fn(async () => ({ mockServerId: "m1", specVersion: "1.2.0", refreshed: true }));
    const deps = makeDeps({ loadSession: async () => SESSION, refreshMock }, [
      entry("spec0_orders", "Orders", { source: { kind: "spec0", ref: "spec0:api-1" }, mockServerId: "m1" }),
    ]);
    const body = json(await runTool("refresh_mock_server", { api: "Orders" }, deps));
    expect(body).toMatchObject({ refreshed: true, specVersion: "1.2.0" });
    expect(deps.setMock).toHaveBeenCalledWith("spec0_orders", {
      mockServerId: "m1",
      mockSpecVersion: "1.2.0",
      clearStale: true,
    });
  });
});

describe("server settings", () => {
  it("makes long, URL-safe, unique tokens", () => {
    const a = newToken();
    const b = newToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^s0mcp_[A-Za-z0-9_-]{43}$/);
  });

  it("is off by default and has a token the first time", async () => {
    const prefs = await loadMcpPrefs();
    expect(prefs.startOnLaunch).toBe(false);
    expect(prefs.port).toBe(DEFAULT_MCP_PORT);
    expect(prefs.token.length).toBeGreaterThanOrEqual(32);
  });

  it("builds setup snippets with the loopback address and the header", () => {
    const snippets = setupSnippets(47321, "s0mcp_TOKEN");
    const claude = snippets.find((row) => row.id === "claude-code")!.text;
    expect(claude).toBe(
      'claude mcp add --transport http spec0-studio http://127.0.0.1:47321/mcp --header "Authorization: Bearer s0mcp_TOKEN"',
    );
    const cursor = JSON.parse(snippets.find((row) => row.id === "cursor")!.text);
    expect(cursor.mcpServers["spec0-studio"]).toEqual({
      url: "http://127.0.0.1:47321/mcp",
      headers: { Authorization: "Bearer s0mcp_TOKEN" },
    });
    expect(maskToken(claude, "s0mcp_TOKEN")).not.toContain("s0mcp_TOKEN");
  });
});
