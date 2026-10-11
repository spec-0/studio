/**
 * The chat panel's attachments, what a message is sent as, the conversations
 * kept on disk, and its settings. The rule throughout: no secret value goes to
 * the agent or onto disk.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatItem } from "../acpClient";
import {
  AGENT_CHAT_STORE,
  chatTitle,
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
  stepMention,
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

  it("start with no agent, so the panel is off", async () => {
    stubStore({});
    expect(await loadAgentChatPrefs()).toEqual({ agent: null, workspace: null });
  });

  it("only take an agent Studio knows", async () => {
    stubStore({ agent: "rm -rf", workspace: "  " });
    expect(await loadAgentChatPrefs()).toEqual({ agent: null, workspace: null });
    stubStore({ agent: "gemini", workspace: "/Users/me/specs" });
    expect(await loadAgentChatPrefs()).toEqual({ agent: "gemini", workspace: "/Users/me/specs" });
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
