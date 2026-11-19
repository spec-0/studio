/**
 * The chat panel's attachments, what a message is sent as, the conversations
 * kept on disk, and its settings. The rule throughout: no secret value goes to
 * the agent or onto disk.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatItem } from "../acpClient";
import {
  AGENT_CHAT_STORE,
  chatSuggestions,
  chatTitle,
  contextBlock,
  EMPTY_SAVED_CHATS,
  filterChoices,
  forgetChat,
  keepChat,
  loadAgentChatPrefs,
  MAX_MENTION_CHARS,
  MAX_RECENT_RESPONSES,
  MAX_SAVED_CHATS,
  mentionChoices,
  operationMention,
  promptBlocks,
  responseMention,
  runMention,
  runOutcome,
  STUDIO_CONTEXT_URI,
  stepMention,
  studioContextNote,
  studioLinkFor,
  studioToolName,
  toolCallTitle,
  type SavedChat,
} from "../agentChat";
import { isAgentChatShortcut } from "../agentChatPanel";
import type { CollectionStep } from "../collection";
import type { HistoryEntry } from "../history";
import { setKnownSecrets } from "../redact";
import { startLog, type RunLog } from "../runLog";
import { SAMPLE_SPEC } from "../sample";
import { parseSpec } from "../spec";

const SECRET = "sk_live_chat_secret_77";
const withSecret = () =>
  setKnownSecrets([{ id: "e", name: "Prod", variables: [{ name: "apiKey", value: SECRET, secret: true }] }]);

afterEach(() => {
  setKnownSecrets([]);
  vi.unstubAllGlobals();
});

const spec = parseSpec(SAMPLE_SPEC, "sample");
const op = spec.operations[0];

const step: CollectionStep = {
  key: "createOrder",
  name: "Create an order",
  api: "orders",
  operation: { method: "POST", path: "/orders" },
  pathParams: {},
  queryParams: { key: SECRET },
  headers: { Authorization: `Bearer ${SECRET}` },
  body: `{"note":"${SECRET}"}`,
};

const history = (id: string, extra: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id,
  at: "2026-10-11T10:00:00.000Z",
  method: "GET",
  path: "/orders/1",
  url: "https://api.example.com/orders/1",
  status: 200,
  ms: 12,
  bytes: 10,
  specTitle: "Orders",
  operationId: "GET /orders/{id}",
  headers: {},
  responseBody: '{"id":1}',
  responseHeaders: { "content-type": "application/json" },
  ...extra,
});

describe("attachments", () => {
  it("describe an operation from the open spec", () => {
    const mention = operationMention("Sample", op);
    expect(mention.kind).toBe("operation");
    expect(mention.label).toBe(`${op.method.toUpperCase()} ${op.path}`);
    expect(mention.text).toContain(`operation: ${op.method.toUpperCase()} ${op.path}`);
    expect(mention.text).toContain("responses:");
  });

  it("replace secret values in a response with their names", () => {
    withSecret();
    const mention = responseMention(
      { method: "GET", url: `https://api.example.com/orders?key=${SECRET}` },
      {
        status: 200,
        statusText: "OK",
        headers: { "x-echo": SECRET, authorization: `Basic ${btoa(`me:${SECRET}`)}` },
        bodyText: `{"token":"${SECRET}"}`,
        ms: 5,
        bytes: 20,
      },
    );
    expect(mention.text).not.toContain(SECRET);
    expect(mention.label).not.toContain(SECRET);
    expect(mention.text).toContain("{{apiKey}}");
  });

  it("say a binary response isn't text instead of sending it", () => {
    const mention = responseMention(
      { method: "GET", url: "https://x.test/logo" },
      {
        status: 200,
        statusText: "OK",
        headers: {},
        bodyText: "",
        ms: 1,
        bytes: 3,
        binary: { contentType: "image/png", byteLength: 3, path: null, previewBase64: null },
      },
    );
    expect(mention.text).toContain("(image/png, 3 bytes, not text)");
  });

  it("send a collection step without secret values", () => {
    withSecret();
    const mention = stepMention({ id: "c1", name: "Checkout" }, step);
    expect(mention.label).toBe("Create an order");
    expect(mention.text).toContain("Collection: Checkout");
    expect(mention.text).not.toContain(SECRET);
  });

  it("send a run log without secret values", () => {
    withSecret();
    const log: RunLog = startLog("r1", { id: "c1", name: "Checkout" }, "Prod", "2026-10-11T10:00:00.000Z");
    log.events.push({ type: "run_started", at: log.startedAt, steps: 1, stopOnFailure: true, targets: [`https://x.test?k=${SECRET}`] } as never);
    const mention = runMention(log);
    expect(mention.text).toContain("Checkout");
    expect(mention.text).not.toContain(SECRET);
  });

  it("cut a long one and say so", () => {
    const mention = responseMention(
      { method: "GET", url: "https://x.test" },
      { status: 200, statusText: "", headers: {}, bodyText: "y".repeat(MAX_MENTION_CHARS * 2), ms: 1, bytes: 1 },
    );
    expect(mention.text.length).toBeLessThan(MAX_MENTION_CHARS + 200);
    expect(mention.text).toMatch(/cut: \d+ more characters/);
  });
});

describe("what a message is sent as", () => {
  const mention = { id: "m", kind: "operation" as const, label: "GET /orders", text: `uses ${SECRET}` };

  it("embeds attachments as resources when the agent takes them", () => {
    withSecret();
    const blocks = promptBlocks(`check ${SECRET}`, [mention], true);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: "text", text: "check {{apiKey}}" });
    expect(blocks[1]).toMatchObject({ type: "resource", resource: { uri: "studio://operation/GET%20%2Forders", text: "uses {{apiKey}}" } });
  });

  it("falls back to text with a heading", () => {
    const blocks = promptBlocks("check", [mention], false);
    expect(blocks[1]).toMatchObject({ type: "text" });
    expect(blocks[1].type === "text" && blocks[1].text).toMatch(/^Attached from Spec0 Studio, operation: GET \/orders/);
  });
});

describe("the @ menu", () => {
  const collections = [
    {
      id: "c1",
      name: "Checkout",
      apis: {},
      steps: [step, { ...step, key: "payOrder", name: undefined }],
      stopOnFailure: true,
      updatedAt: "",
    },
  ];
  const runs = (id: string): RunLog[] =>
    id === "c1" ? [1, 2, 3, 4].map((n) => startLog(`r${n}`, { id: "c1", name: "Checkout" }, null, `2026-10-0${n}T00:00:00Z`)) : [];

  it("lists the operation on screen first, then the rest, responses, steps and runs", () => {
    const current = spec.operations[1];
    const choices = mentionChoices({
      api: { title: "Sample", operations: spec.operations, current },
      history: [history("h1"), history("h2", { responseBody: undefined }), ...Array.from({ length: 8 }, (_, i) => history(`x${i}`))],
      collections,
      runsFor: runs,
    });
    expect(choices[0].label).toBe(`${current.method.toUpperCase()} ${current.path}`);
    expect(choices.filter((c) => c.kind === "operation")).toHaveLength(spec.operations.length);
    // Only entries that kept their response, and only the latest few.
    const responses = choices.filter((c) => c.kind === "response");
    expect(responses).toHaveLength(MAX_RECENT_RESPONSES);
    expect(responses.map((c) => c.id)).not.toContain("response:h2");
    expect(choices.filter((c) => c.kind === "step").map((c) => c.label)).toEqual(["Create an order", "payOrder"]);
    expect(choices.filter((c) => c.kind === "run")).toHaveLength(3);
  });

  it("builds what's sent only when picked", () => {
    const choices = mentionChoices({ api: null, history: [history("h1")], collections: [], runsFor: () => [] });
    const built = choices[0].build();
    expect(built.id).toBe("response:h1");
    expect(built.text).toContain('{"id":1}');
  });

  it("filters on every word typed", () => {
    const choices = mentionChoices({ api: null, history: [], collections, runsFor: runs });
    expect(filterChoices(choices, "step pay").map((c) => c.label)).toEqual(["payOrder"]);
    expect(filterChoices(choices, "")).toHaveLength(choices.length);
  });
});

describe("kept conversations", () => {
  const chat = (id: string, items: ChatItem[] = [{ kind: "user", id: "u", text: "Hello agent", mentions: [] }]): SavedChat => ({
    id,
    agent: "claude",
    agentName: "Claude Code",
    title: "",
    startedAt: "2026-10-11T10:00:00Z",
    updatedAt: "2026-10-11T10:00:00Z",
    items,
  });

  it("are titled by the first message", () => {
    expect(chatTitle([{ kind: "user", id: "u", text: "Why does step 3 fail?\nmore", mentions: [] }])).toBe("Why does step 3 fail?");
    expect(chatTitle([])).toBe("New chat");
  });

  it("are kept newest first, replaced in place, and capped", () => {
    let store = EMPTY_SAVED_CHATS;
    for (let i = 0; i < MAX_SAVED_CHATS + 5; i++) store = keepChat(store, chat(`c${i}`));
    expect(store.chats).toHaveLength(MAX_SAVED_CHATS);
    expect(store.chats[0].id).toBe(`c${MAX_SAVED_CHATS + 4}`);
    store = keepChat(store, chat("c10"));
    expect(store.chats[0].id).toBe("c10");
    expect(store.chats.filter((c) => c.id === "c10")).toHaveLength(1);
    expect(forgetChat(store, "c10").chats.some((c) => c.id === "c10")).toBe(false);
  });

  it("are stored without secret values and with no question left open", () => {
    withSecret();
    const store = keepChat(
      EMPTY_SAVED_CHATS,
      chat("c1", [
        { kind: "user", id: "u", text: `my key is ${SECRET}`, mentions: [] },
        { kind: "tool", id: "t", toolCallId: "t", title: "curl", status: "completed", output: SECRET },
        { kind: "permission", id: "p", title: "Run curl", options: [], state: "pending" },
      ]),
    );
    expect(JSON.stringify(store)).not.toContain(SECRET);
    expect(store.chats[0].items[2]).toMatchObject({ kind: "permission", state: "cancelled" });
  });
});

describe("settings", () => {
  const stubStore = (value: unknown) => {
    const data = new Map([[`studio:${AGENT_CHAT_STORE}`, JSON.stringify(value)]]);
    vi.stubGlobal("window", { localStorage: { getItem: (key: string) => data.get(key) ?? null, setItem: () => undefined } });
  };

  it("start with no agent, so the panel is off, and with Studio's tools on", async () => {
    stubStore({});
    expect(await loadAgentChatPrefs()).toEqual({ agent: null, workspace: null, studioTools: true, instructions: true });
  });

  it("only take an agent Studio knows", async () => {
    stubStore({ agent: "rm -rf", workspace: "  " });
    expect(await loadAgentChatPrefs()).toEqual({ agent: null, workspace: null, studioTools: true, instructions: true });
    stubStore({ agent: "gemini", workspace: "/Users/me/specs" });
    expect(await loadAgentChatPrefs()).toEqual({ agent: "gemini", workspace: "/Users/me/specs", studioTools: true, instructions: true });
  });

  it("turn Studio's tools off only when told to", async () => {
    stubStore({ agent: "codex", studioTools: false });
    expect((await loadAgentChatPrefs()).studioTools).toBe(false);
    stubStore({ agent: "codex", studioTools: "no" });
    expect((await loadAgentChatPrefs()).studioTools).toBe(true);
  });
});

describe("the shortcut", () => {
  const press = (extra: Partial<KeyboardEvent>) => ({
    key: "j",
    code: "KeyJ",
    ctrlKey: false,
    metaKey: false,
    shiftKey: true,
    altKey: false,
    ...extra,
  });

  it("is ⌘⇧J on macOS and Ctrl+Shift+J elsewhere", () => {
    expect(isAgentChatShortcut(press({ metaKey: true }), { mac: true })).toBe(true);
    expect(isAgentChatShortcut(press({ ctrlKey: true }), { mac: true })).toBe(false);
    expect(isAgentChatShortcut(press({ ctrlKey: true }), { mac: false })).toBe(true);
    expect(isAgentChatShortcut(press({ metaKey: true, shiftKey: false }), { mac: true })).toBe(false);
  });
});

describe("the note a chat starts with", () => {
  const open = {
    api: { title: "Orders API", version: "1.2.0" },
    operation: { method: "post", path: "/orders", summary: "Create an order" },
    collection: { name: "Checkout", steps: 4, lastRun: "failed" as const },
  };

  it("says where the agent is, which tools it has, and what's open", () => {
    const note = studioContextNote(open, true);
    expect(note).toContain("inside Spec0 Studio");
    expect(note).toContain("MCP server named spec0-studio");
    expect(note).toContain("- API: Orders API 1.2.0");
    expect(note).toContain("- Operation: POST /orders (Create an order)");
    expect(note).toContain("- Collection: Checkout (4 steps, last run failed)");
  });

  it("says so when the tools aren't connected, and when nothing is open", () => {
    const note = studioContextNote({}, false);
    expect(note).toContain("aren't connected");
    expect(note).not.toContain("spec0-studio");
    expect(note).toContain("Nothing in particular is open");
  });

  it("never carries a secret value", () => {
    withSecret();
    const note = studioContextNote({ api: { title: `Orders ${SECRET}` } }, true);
    expect(note).not.toContain(SECRET);
    expect(note).toContain("{{apiKey}}");
  });

  it("goes first, as an embedded resource when the agent takes them and as text otherwise", () => {
    const embedded = promptBlocks("test it", [], true, "the note");
    expect(embedded[0]).toEqual({
      type: "resource",
      resource: { uri: STUDIO_CONTEXT_URI, mimeType: "text/plain", text: "the note" },
    });
    expect(embedded[1]).toEqual({ type: "text", text: "test it" });
    expect(contextBlock("the note", false)).toEqual({ type: "text", text: "Context from Spec0 Studio:\n\nthe note" });
    expect(promptBlocks("test it", [], true)).toEqual([{ type: "text", text: "test it" }]);
  });
});

describe("suggestions in an empty chat", () => {
  it("follow what's open", () => {
    expect(
      chatSuggestions({
        api: { title: "Orders API" },
        operation: { method: "get", path: "/orders/{id}" },
      }),
    ).toEqual([
      "Send GET /orders/{id} and check the response against the spec",
      "Test the Orders API against a local mock",
      "Build a collection that walks through the main flow of the Orders API",
    ]);
  });

  it("ask about a failed run", () => {
    expect(chatSuggestions({ collection: { name: "Checkout", steps: 3, lastRun: "failed" } })).toEqual([
      "Why did the last run of Checkout fail?",
    ]);
    expect(chatSuggestions({ collection: { name: "Checkout", steps: 3, lastRun: null } })).toEqual([
      "Run Checkout and explain anything that fails",
    ]);
  });

  it("have something to offer when nothing is open, and never more than four", () => {
    expect(chatSuggestions({}).length).toBe(2);
    const all = chatSuggestions({
      api: { title: "A" },
      operation: { method: "get", path: "/x" },
      collection: { name: "C", steps: 1 },
    });
    expect(all.length).toBe(4);
  });
});

describe("a collection run's outcome", () => {
  it("is failed when a step failed or the run stopped early, and unknown while it runs", () => {
    const done = { finishedAt: "2026-10-12T10:00:00Z", counts: { total: 3, passed: 3, failed: 0, skipped: 0 } };
    expect(runOutcome(done)).toBe("passed");
    expect(runOutcome({ ...done, counts: { ...done.counts, passed: 2, failed: 1 } })).toBe("failed");
    expect(runOutcome({ ...done, stoppedEarly: true })).toBe("failed");
    expect(runOutcome({ counts: done.counts })).toBeNull();
    expect(runOutcome(undefined)).toBeNull();
  });
});

describe("tool cards for Studio's tools", () => {
  const card = (title: string, output: string, extra: Partial<Extract<ChatItem, { kind: "tool" }>> = {}) =>
    ({ kind: "tool", id: "t", toolCallId: "c", title, status: "completed", output, ...extra }) as Extract<
      ChatItem,
      { kind: "tool" }
    >;
  const created = JSON.stringify({ id: "col_abc123", name: "Checkout", draft: true, steps: [] });
  const ran = JSON.stringify({ collection: "Checkout", runId: "run_9", summary: "3 passed", passed: true });

  it("name Studio's tool and say a bare tool id in words", () => {
    expect(studioToolName(card("mcp__spec0-studio__get_run_log", ""))).toBe("get_run_log");
    expect(toolCallTitle(card("mcp__spec0-studio__get_run_log", ""))).toBe("Get run log");
    expect(toolCallTitle(card("Tool: spec0-studio/run_collection", ""))).toBe("Run collection");
    const described = card("Calling a tool", "", { input: JSON.stringify({ tool: "run_collection" }) });
    expect(studioToolName(described)).toBe("run_collection");
    expect(toolCallTitle(described)).toBe("Calling a tool");
    expect(studioToolName(card("Read file src/main.rs", ""))).toBeNull();
  });

  it("link to the collection an agent created", () => {
    expect(studioLinkFor(card("mcp__spec0-studio__create_collection", created))).toEqual({
      tool: "create_collection",
      collection: "col_abc123",
    });
  });

  it("read the result when the agent wraps it, as MCP clients do", () => {
    const wrapped = JSON.stringify({ content: [{ type: "text", text: created }], isError: false }, null, 2);
    expect(studioLinkFor(card("Tool: spec0-studio/create_collection", wrapped))).toMatchObject({
      collection: "col_abc123",
    });
  });

  it("link to the run an agent started, found by the tool name in the input", () => {
    const item = card("Calling a tool", ran, { input: JSON.stringify({ server: "spec0-studio", tool: "run_collection" }) });
    expect(studioLinkFor(item)).toEqual({ tool: "run_collection", collection: "Checkout", runId: "run_9" });
  });

  it("don't link a call that hasn't finished, another tool, or output Studio doesn't recognise", () => {
    expect(studioLinkFor(card("create_collection", created, { status: "in_progress" }))).toBeNull();
    expect(studioLinkFor(card("send_request", created))).toBeNull();
    expect(studioLinkFor(card("create_collection", "Couldn't create it."))).toBeNull();
  });
});
