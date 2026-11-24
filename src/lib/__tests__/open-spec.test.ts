/**
 * `open_spec`: an agent adds a spec to the library. Runs the real library path
 * (`addSpecText`, over an in-memory store) and the real approval gate, so the
 * test sees what the developer would: the question, and what ends up stored.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const files = new Map<string, unknown>();
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../store", async (original) => ({
  ...(await original<typeof import("../store")>()),
  readStore: async (name: string, fallback: unknown) => (files.has(name) ? structuredClone(files.get(name)) : fallback),
  writeStore: async (name: string, value: unknown) => void files.set(name, structuredClone(value)),
}));

const { answerApproval, gateOpenSpec, pendingApprovals, resetAgentControl, sessionGrants, setAgentRules, stopAgents } = await import(
  "../agentControl"
);
const library = await import("../library");
const { runAgentTool, specSource } = await import("../mcpAgent");
import type { AgentToolDeps } from "../mcpAgent";
import type { ToolResult } from "../mcp";

const ORDERS = `openapi: 3.0.3
info: { title: Orders, version: 1.2.0 }
paths:
  /orders:
    get: { operationId: listOrders, responses: { "200": { description: ok } } }
    post: { operationId: createOrder, responses: { "201": { description: created } } }
`;

const SWAGGER = JSON.stringify({
  swagger: "2.0",
  info: { title: "Pets", version: "2.0.1" },
  host: "pets.example.com",
  basePath: "/v1",
  schemes: ["https"],
  paths: { "/pets": { get: { operationId: "listPets", produces: ["application/json"], responses: { "200": { description: "ok" } } } } },
});

interface World {
  deps: AgentToolDeps;
  disk: Record<string, string>;
  web: Record<string, string>;
  fetched: string[];
  changed: number;
  activity: string[];
}

function world(): World {
  const w: World = { disk: {}, web: {}, fetched: [], changed: 0, activity: [] } as unknown as World;
  const unused = () => {
    throw new Error("not used here");
  };
  w.deps = {
    app: () => null,
    loadLibrary: library.loadLibrary,
    readSpecText: library.readSpecText,
    send: unused,
    gateRequest: unused,
    gateMockStart: unused,
    gateSave: unused,
    gateOpenSpec,
    stopGeneration: () => 0,
    recordActivity: (entry) => void w.activity.push(entry.summary),
    recordHistory: unused,
    readFile: async (path) => w.disk[path] ?? null,
    rereadFile: unused,
    fetchText: async (url) => {
      w.fetched.push(url);
      if (!(url in w.web)) throw new Error(`${url} answered 404.`);
      return w.web[url];
    },
    applyUpdate: unused,
    specChanged: unused,
    addSpec: library.addSpecText,
    libraryChanged: () => void (w.changed += 1),
  };
  return w;
}

const call = (w: World, args: Record<string, unknown>) => runAgentTool("open_spec", args, w.deps, { agent: "Claude Code" });
const textOf = (result: ToolResult) => result.content.map((part) => part.text).join("\n");
const json = (result: ToolResult) => JSON.parse(result.content[0].text);

/** Wait for Studio to ask, then answer. Returns what the developer was shown. */
async function answer(choice: "once" | "deny") {
  await vi.waitFor(() => expect(pendingApprovals()).toHaveLength(1));
  const [shown] = pendingApprovals();
  answerApproval(shown.id, choice);
  return shown;
}

beforeEach(() => {
  files.clear();
  resetAgentControl();
});

describe("open_spec", () => {
  it("asks with the path shown, adds the file the way Open does, and returns what the other tools need", async () => {
    const w = world();
    w.disk["/repo/orders.yaml"] = ORDERS;
    const pending = call(w, { source: "/repo/orders.yaml" });
    const shown = await answer("once");
    expect(shown).toMatchObject({ kind: "open", title: "Claude Code wants to add a spec to the library", answers: ["deny", "once"] });
    expect(shown.lines[0]).toBe("/repo/orders.yaml");

    const result = json(await pending);
    const id = library.idForSource({ kind: "file", ref: "/repo/orders.yaml" });
    expect(result).toMatchObject({ id, title: "Orders", version: "1.2.0", operations: 2, added: true });
    expect(result.note).toMatch(/search_operations/);
    const [stored] = await library.loadLibrary();
    expect(stored).toMatchObject({ id, title: "Orders", source: { kind: "file", ref: "/repo/orders.yaml" }, operations: 2 });
    expect(await library.readSpecText(id)).toBe(ORDERS);
    expect(w.changed).toBe(1);
    expect(w.activity).toEqual(["Added Orders to the library"]);
  });

  it("adds nothing and reads nothing when the developer says no", async () => {
    const w = world();
    const read = vi.fn(async () => ORDERS);
    w.deps.readFile = read;
    const pending = call(w, { source: "/repo/orders.yaml" });
    await answer("deny");
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/didn't allow adding \/repo\/orders.yaml/);
    expect(read).not.toHaveBeenCalled();
    expect(await library.loadLibrary()).toEqual([]);
  });

  it("is refused when the developer stops agents while it waits", async () => {
    const w = world();
    w.disk["/repo/orders.yaml"] = ORDERS;
    const pending = call(w, { source: "/repo/orders.yaml" });
    await vi.waitFor(() => expect(pendingApprovals()).toHaveLength(1));
    stopAgents();
    expect(textOf(await pending)).toMatch(/stopped agents/);
    expect(await library.loadLibrary()).toEqual([]);
  });

  it("doesn't add a spec twice: it reports the entry and offers reload_spec, without asking", async () => {
    const w = world();
    await library.addSpecText(ORDERS, "orders.yaml", { kind: "file", ref: "/repo/orders.yaml" });
    const result = json(await call(w, { source: "/repo/orders.yaml" }));
    expect(result).toMatchObject({ title: "Orders", operations: 2, added: false });
    expect(result.note).toMatch(/reload_spec/);
    expect(pendingApprovals()).toEqual([]);
    expect(await library.loadLibrary()).toHaveLength(1);
    expect(w.changed).toBe(0);
  });

  it("refuses a document that doesn't parse or isn't OpenAPI, with the reason, and adds nothing", async () => {
    const w = world();
    w.disk["/repo/broken.yaml"] = "openapi: 3.0.3\ninfo: [";
    w.disk["/repo/config.json"] = JSON.stringify({ name: "not a spec" });

    const broken = call(w, { source: "/repo/broken.yaml" });
    await answer("once");
    const brokenResult = await broken;
    expect(brokenResult.isError).toBe(true);
    expect(textOf(brokenResult)).toMatch(/couldn't load \/repo\/broken.yaml, so nothing was added/);

    const other = call(w, { source: "/repo/config.json" });
    await answer("once");
    expect(textOf(await other)).toMatch(/nothing was added: No `openapi` or `swagger` version field/);

    expect(await library.loadLibrary()).toEqual([]);
    expect(w.changed).toBe(0);
  });

  it("says so when the file can't be read", async () => {
    const w = world();
    const pending = call(w, { source: "/repo/missing.yaml" });
    await answer("once");
    expect(textOf(await pending)).toMatch(/Couldn't read \/repo\/missing.yaml/);
  });

  it("converts Swagger 2.0 as Open does, keeping the text as given", async () => {
    const w = world();
    w.disk["/repo/pets.json"] = SWAGGER;
    const pending = call(w, { source: "/repo/pets.json" });
    await answer("once");
    const result = json(await pending);
    expect(result).toMatchObject({ title: "Pets", version: "2.0.1", operations: 1, converted: { from: "Swagger 2.0", to: "OpenAPI 3.0" } });
    expect(await library.readSpecText(result.id)).toBe(SWAGGER);
  });

  it("fetches a URL after asking, with the URL shown, counted as a request", async () => {
    const w = world();
    w.web["https://specs.example.com/orders.yaml"] = ORDERS;
    const pending = call(w, { source: "https://specs.example.com/orders.yaml" });
    const shown = await answer("once");
    expect(shown.lines[0]).toBe("https://specs.example.com/orders.yaml");
    expect(shown.lines[1]).toMatch(/one GET request to specs.example.com:443/);
    const result = json(await pending);
    expect(result).toMatchObject({ title: "Orders", source: "https://specs.example.com/orders.yaml", added: true });
    expect(w.fetched).toEqual(["https://specs.example.com/orders.yaml"]);
    const [stored] = await library.loadLibrary();
    expect(stored.source).toEqual({ kind: "url", ref: "https://specs.example.com/orders.yaml" });
    // Allowing this one fetch doesn't allow the host for later requests.
    expect(sessionGrants().hosts).toEqual([]);
  });

  it("refuses a blocked host without asking or fetching", async () => {
    setAgentRules({ blockedHosts: ["*.internal.example.com"] });
    const w = world();
    const result = await call(w, { source: "https://specs.internal.example.com/orders.yaml" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/blocked agents from sending requests to \*\.internal\.example\.com/);
    expect(pendingApprovals()).toEqual([]);
    expect(w.fetched).toEqual([]);
  });

  it("counts the fetch towards the request cap", async () => {
    setAgentRules({ maxRequestsPerMinute: 1 });
    const w = world();
    w.web["https://a.example.com/a.yaml"] = ORDERS;
    w.web["https://b.example.com/b.yaml"] = ORDERS;
    const first = call(w, { source: "https://a.example.com/a.yaml" });
    await answer("once");
    expect((await first).isError).toBeUndefined();
    const second = call(w, { source: "https://b.example.com/b.yaml" });
    await answer("once");
    expect(textOf(await second)).toMatch(/limit for agent requests \(1 a minute\)/);
    expect(w.fetched).toEqual(["https://a.example.com/a.yaml"]);
  });

  it("reports a fetch that fails, and adds nothing", async () => {
    const w = world();
    const pending = call(w, { source: "https://specs.example.com/gone.yaml" });
    await answer("once");
    expect(textOf(await pending)).toMatch(/Couldn't fetch https:\/\/specs.example.com\/gone.yaml, so nothing was added: .*404/);
    expect(await library.loadLibrary()).toEqual([]);
  });

  it("takes only absolute spec file paths and http(s) URLs", async () => {
    expect(specSource("/repo/openapi.yml")).toEqual({ kind: "file", ref: "/repo/openapi.yml" });
    expect(specSource("C:\\repo\\openapi.json")).toEqual({ kind: "file", ref: "C:\\repo\\openapi.json" });
    expect(specSource("http://localhost:8080/openapi.json")).toEqual({ kind: "url", ref: "http://localhost:8080/openapi.json" });
    expect(() => specSource(undefined)).toThrow(/Pass source/);
    expect(() => specSource("specs/openapi.yaml")).toThrow(/absolute path/);
    expect(() => specSource("/home/me/.ssh/id_rsa")).toThrow(/\.yaml, \.yml or \.json/);
    expect(() => specSource("ftp://example.com/openapi.yaml")).toThrow(/not ftp: URLs/);
    expect(() => specSource("file:///repo/openapi.yaml")).toThrow(/not file: URLs/);

    const w = world();
    const result = await call(w, { source: "openapi.yaml" });
    expect(result.isError).toBe(true);
    expect(pendingApprovals()).toEqual([]);
  });

  it("is what other tools point to when an API isn't in the library", async () => {
    const w = world();
    const result = await runAgentTool("validate_spec", { api: "Nothing" }, w.deps, { agent: "Claude Code" });
    expect(textOf(result)).toMatch(/open_spec/);
  });
});
