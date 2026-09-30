/**
 * The app console: what it keeps, how it filters, and that it never holds a
 * secret or an MCP call's arguments.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearConsole,
  consoleState,
  entriesText,
  filterEntries,
  logMcpCall,
  logMockRequest,
  logRequest,
  logToConsole,
  MAX_CONSOLE_ENTRIES,
  resetConsole,
  setConsoleOpen,
  subscribeConsole,
  toggleConsole,
} from "../appConsole";
import { setKnownSecrets } from "../redact";
import { send } from "../request";

const SECRET = "sk_live_console_77";

beforeEach(() => resetConsole());
afterEach(() => {
  setKnownSecrets([]);
  vi.unstubAllGlobals();
});

const mixed = () => {
  logRequest({ method: "GET", url: "https://api.example.com/orders" }, { status: 200, ms: 12 });
  logRequest({ method: "POST", url: "https://api.example.com/orders" }, { error: "connection refused" });
  logToConsole({ source: "collection", level: "info", text: "Run started: Checkout", run: { collectionId: "c", runId: "r" } });
  logMockRequest("Orders", { method: "GET", path: "/orders/1" }, { status: 200 }, ["query limit: expected an integer"]);
  logMcpCall("list_local_apis", true);
  logMcpCall("get_api_spec", false);
};

describe("the console", () => {
  it("keeps entries in order, each with a time", () => {
    mixed();
    const { entries } = consoleState();
    expect(entries.map((e) => e.source)).toEqual(["request", "request", "collection", "mock", "mcp", "mcp"]);
    expect(entries.every((e) => !Number.isNaN(Date.parse(e.at)))).toBe(true);
    expect(entries[0].text).toBe("GET https://api.example.com/orders → 200 · 12 ms");
    expect(entries[3]).toMatchObject({ method: "GET", url: "/orders/1", status: 200, notes: ["query limit: expected an integer"] });
  });

  it("filters by kind, errors and text", () => {
    mixed();
    const { entries } = consoleState();
    expect(filterEntries(entries, "all")).toHaveLength(6);
    expect(filterEntries(entries, "requests")).toHaveLength(2);
    expect(filterEntries(entries, "collections")).toHaveLength(1);
    expect(filterEntries(entries, "mock")).toHaveLength(1);
    expect(filterEntries(entries, "mcp")).toHaveLength(2);
    expect(filterEntries(entries, "errors").map((e) => e.text)).toEqual([
      "POST https://api.example.com/orders failed: connection refused",
      "MCP get_api_spec → error",
    ]);
    expect(filterEntries(entries, "all", "checkout")).toHaveLength(1);
    expect(filterEntries(entries, "requests", "POST")).toHaveLength(1);
  });

  it("keeps the last entries only, and counts what it dropped", () => {
    for (let i = 0; i < MAX_CONSOLE_ENTRIES + 25; i += 1) logToConsole({ source: "request", level: "info", text: `#${i}` });
    const { entries, dropped } = consoleState();
    expect(entries).toHaveLength(MAX_CONSOLE_ENTRIES);
    expect(entries[0].text).toBe("#25");
    expect(dropped).toBe(25);
    clearConsole();
    expect(consoleState()).toMatchObject({ entries: [], dropped: 0 });
  });

  it("counts new errors while closed, and resets the count when opened", () => {
    const seen: number[] = [];
    const stop = subscribeConsole(() => seen.push(consoleState().unseenErrors));
    mixed();
    expect(consoleState().unseenErrors).toBe(2);
    toggleConsole();
    expect(consoleState()).toMatchObject({ open: true, unseenErrors: 0 });
    logRequest({ method: "GET", url: "https://x" }, { error: "timeout" });
    expect(consoleState().unseenErrors).toBe(0);
    setConsoleOpen(false);
    stop();
    expect(seen.length).toBeGreaterThan(0);
  });

  it("copies as text", () => {
    mixed();
    const text = entriesText(consoleState().entries);
    expect(text.split("\n")[0]).toMatch(/Z {2}REQUEST {2}GET https:\/\/api\.example\.com\/orders → 200/);
    expect(text).toContain("    query limit: expected an integer");
  });

  it("logs MCP calls by name and outcome, never an odd name as given", () => {
    logMcpCall("get_api_spec", true);
    logMcpCall("<script>alert(1)</script>", false);
    const { entries } = consoleState();
    expect(entries.map((e) => e.tool)).toEqual(["get_api_spec", "(unknown tool)"]);
    // No field could hold arguments.
    expect(Object.keys(entries[0]).sort()).toEqual(["at", "id", "level", "source", "text", "tool"]);
  });
});

describe("secret values never reach the console", () => {
  beforeEach(() =>
    setKnownSecrets([{ id: "e", name: "Staging", variables: [{ name: "apiKey", value: SECRET, secret: true }] }]),
  );

  it("redacts requests, mock requests and anything else logged", () => {
    logRequest({ method: "GET", url: `https://api.example.com/orders?key=${SECRET}` }, { status: 200, ms: 3 });
    logRequest({ method: "GET", url: `https://api.example.com/x?key=${SECRET}` }, { error: `refused for key ${SECRET}` });
    logMockRequest("Orders", { method: "GET", path: `/orders/${SECRET}` }, { status: 404 }, [`unknown id ${SECRET}`]);
    logToConsole({ source: "collection", level: "info", text: `Run started with ${SECRET}` });
    const all = JSON.stringify(consoleState().entries);
    expect(all).not.toContain(SECRET);
    expect(all).toContain("{{apiKey}}");
    expect(entriesText(consoleState().entries)).not.toContain(SECRET);
  });

  it("records what `send` sent, redacted, including failures", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.includes("down")) throw new Error(`connect failed: ${url}`);
      return new Response('{"ok":true}', { status: 201, statusText: "Created" });
    });
    vi.stubGlobal("window", { fetch });
    await send({ method: "POST", url: `https://api.example.com/orders?key=${SECRET}`, headers: { Authorization: `Bearer ${SECRET}` } });
    await expect(send({ method: "GET", url: `https://down.example.com/?key=${SECRET}`, headers: {} })).rejects.toThrow();
    const { entries } = consoleState();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ source: "request", method: "POST", status: 201, url: "https://api.example.com/orders?key={{apiKey}}" });
    expect(entries[1]).toMatchObject({ level: "error" });
    expect(JSON.stringify(entries)).not.toContain(SECRET);
  });
});
