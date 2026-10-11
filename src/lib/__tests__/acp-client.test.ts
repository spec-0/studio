/**
 * The chat panel's ACP client: folding session updates into a conversation,
 * and a whole session against a stand-in agent (`scripts/fake-acp-agent.mjs`)
 * running as a real process, the way Studio runs one: lines in on standard
 * input, lines out on standard output, through the same stream code.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import type { RequestPermissionRequest, RequestPermissionResponse, SessionUpdate } from "@agentclientprotocol/sdk";
import {
  applyUpdate,
  blockText,
  isAuthRequired,
  MAX_TOOL_TEXT,
  openChat,
  studioMcpServer,
  type ChatItem,
} from "../acpClient";
import { __events, connectProcess, splitArgs, type AgentProcess } from "../acpProcess";

const FAKE_AGENT = fileURLToPath(new URL("../../../scripts/fake-acp-agent.mjs", import.meta.url));

describe("folding updates into the conversation", () => {
  const chunk = (text: string, messageId?: string): SessionUpdate => ({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
    ...(messageId ? { messageId } : {}),
  });

  it("joins streamed text into one message", () => {
    let items: ChatItem[] = [];
    items = applyUpdate(items, chunk("Hello, "));
    items = applyUpdate(items, chunk("world"));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "agent", text: "Hello, world" });
  });

  it("starts a new message when the message id changes", () => {
    let items: ChatItem[] = [];
    items = applyUpdate(items, chunk("one", "m1"));
    items = applyUpdate(items, chunk(" more", "m1"));
    items = applyUpdate(items, chunk("two", "m2"));
    expect(items.map((item) => item.kind === "agent" && item.text)).toEqual(["one more", "two"]);
  });

  it("keeps thinking apart from the answer", () => {
    let items: ChatItem[] = [];
    items = applyUpdate(items, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Hmm" } });
    items = applyUpdate(items, chunk("Answer"));
    expect(items.map((item) => item.kind)).toEqual(["thought", "agent"]);
  });

  it("tracks a tool call through its updates", () => {
    let items: ChatItem[] = [];
    items = applyUpdate(items, {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Read orders.yaml",
      kind: "read",
      status: "pending",
      rawInput: { path: "orders.yaml" },
    });
    items = applyUpdate(items, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "openapi: 3.1.0" } }],
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "tool",
      title: "Read orders.yaml",
      status: "completed",
      output: "openapi: 3.1.0",
    });
    expect(items[0].kind === "tool" && items[0].input).toContain('"path": "orders.yaml"');
  });

  it("shows an update for a tool call it never saw start", () => {
    const items = applyUpdate([], { sessionUpdate: "tool_call_update", toolCallId: "t9", status: "failed" });
    expect(items[0]).toMatchObject({ kind: "tool", toolCallId: "t9", status: "failed" });
  });

  it("cuts a long tool output", () => {
    const items = applyUpdate([], {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Dump",
      rawOutput: "x".repeat(MAX_TOOL_TEXT + 500),
    });
    const output = items[0].kind === "tool" ? items[0].output! : "";
    expect(output.length).toBeLessThan(MAX_TOOL_TEXT + 100);
    expect(output).toContain("500 more characters");
  });

  it("replaces the plan within a turn and starts a new one after the next message", () => {
    const plan = (content: string): SessionUpdate => ({
      sessionUpdate: "plan",
      entries: [{ content, priority: "medium", status: "pending" }],
    });
    let items: ChatItem[] = applyUpdate([], plan("first"));
    items = applyUpdate(items, plan("revised"));
    expect(items.filter((item) => item.kind === "plan")).toHaveLength(1);
    items = [...items, { kind: "user", id: "u", text: "next", mentions: [] }];
    items = applyUpdate(items, plan("second turn"));
    expect(items.filter((item) => item.kind === "plan")).toHaveLength(2);
  });

  it("ignores updates the panel doesn't show", () => {
    const items: ChatItem[] = [];
    expect(applyUpdate(items, { sessionUpdate: "usage_update", used: 10, size: 100 } as SessionUpdate)).toBe(items);
  });

  it("describes non-text content briefly", () => {
    expect(blockText({ type: "image", data: "", mimeType: "image/png" })).toBe("[image]");
    expect(blockText({ type: "resource_link", uri: "file:///a.yaml", name: "a.yaml" })).toBe("[a.yaml]");
  });
});

describe("arguments typed in Settings", () => {
  it("splits on spaces and keeps quoted parts together", () => {
    expect(splitArgs('--acp --dir "My Specs" \'a b\'')).toEqual(["--acp", "--dir", "My Specs", "a b"]);
    expect(splitArgs("  ")).toEqual([]);
  });
});

describe("the MCP server entry", () => {
  it("carries the token as a header", () => {
    expect(studioMcpServer({ url: "http://127.0.0.1:47321/mcp", token: "tok" })).toEqual({
      type: "http",
      name: "spec0-studio",
      url: "http://127.0.0.1:47321/mcp",
      headers: [{ name: "Authorization", value: "Bearer tok" }],
    });
  });
});

// A session with a real process

let nextSession = 100;
const children: ChildProcessWithoutNullStreams[] = [];
const servers: Server[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
  for (const server of servers.splice(0)) server.close();
  __events.reset();
});

/** Run the stand-in agent and connect to it the way `startAgent` does. */
function runFakeAgent(env: Record<string, string> = {}): AgentProcess {
  const session = nextSession++;
  const child = spawn(process.execPath, [FAKE_AGENT], { env: { ...process.env, ...env } });
  children.push(child);
  createInterface({ input: child.stdout }).on("line", (line) => __events.deliverLine(session, line));
  child.on("exit", (code) => __events.deliverExit(session, { code, stderr: "" }));
  return connectProcess(
    { session, command: "node fake-acp-agent.mjs", cwd: process.cwd() },
    async (line) => void child.stdin.write(`${line}\n`),
    { stop: async () => void child.kill(), stderr: async () => "" },
  );
}

function collector() {
  let items: ChatItem[] = [];
  const asked: RequestPermissionRequest[] = [];
  let reply: (request: RequestPermissionRequest) => RequestPermissionResponse = () => ({
    outcome: { outcome: "cancelled" },
  });
  return {
    handlers: {
      onUpdate: (update: SessionUpdate) => {
        items = applyUpdate(items, update);
      },
      onPermission: async (request: RequestPermissionRequest) => {
        asked.push(request);
        return reply(request);
      },
    },
    items: () => items,
    asked,
    answerWith: (fn: typeof reply) => (reply = fn),
  };
}

const OPTIONS = { cwd: process.cwd(), mcp: null, studioVersion: "0.4.0", startTimeoutMs: 15_000 };

describe("a session with an agent process", () => {
  it("initializes, starts a session and streams a reply", async () => {
    const agent = runFakeAgent();
    const seen = collector();
    const chat = await openChat(agent.stream, seen.handlers, OPTIONS);
    expect(chat.agent.title).toBe("Fake agent");
    expect(chat.embeddedContext).toBe(true);
    expect(chat.mcp).toBe("server-off");

    expect(await chat.prompt([{ type: "text", text: "hello there" }])).toBe("end_turn");
    const agentText = seen.items().filter((item) => item.kind === "agent").map((item) => item.kind === "agent" && item.text);
    expect(agentText).toEqual(["You said: hello there"]);
    expect(seen.items().some((item) => item.kind === "plan")).toBe(true);
    chat.close();
  });

  it("gives the agent Studio's MCP server with its token, and the agent can call it", async () => {
    let auth = "";
    const server = createServer((req, res) => {
      auth = req.headers.authorization ?? "";
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "list_local_apis" }, { name: "get_operation" }] } }));
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as { port: number }).port;

    const agent = runFakeAgent();
    const seen = collector();
    const chat = await openChat(agent.stream, seen.handlers, {
      ...OPTIONS,
      mcp: { url: `http://127.0.0.1:${port}/mcp`, token: "s0mcp_test_token" },
    });
    expect(chat.mcp).toBe("connected");
    await chat.prompt([{ type: "text", text: "use mcp please" }]);
    expect(auth).toBe("Bearer s0mcp_test_token");
    const reply = seen.items().find((item) => item.kind === "agent");
    expect(reply?.kind === "agent" && reply.text).toContain("2 tools: list_local_apis, get_operation");
    chat.close();
  });

  it("asks the user before the agent uses a tool, and passes on the answer", async () => {
    const agent = runFakeAgent();
    const seen = collector();
    seen.answerWith((request) => ({
      outcome: { outcome: "selected", optionId: request.options.find((option) => option.kind === "allow_once")!.optionId },
    }));
    const chat = await openChat(agent.stream, seen.handlers, OPTIONS);
    await chat.prompt([{ type: "text", text: "run the tool" }]);
    expect(seen.asked).toHaveLength(1);
    expect(seen.asked[0].toolCall.title).toBe("Read orders.yaml");
    expect(seen.items().find((item) => item.kind === "tool")).toMatchObject({ status: "completed", output: "openapi: 3.1.0" });

    seen.answerWith((request) => ({
      outcome: { outcome: "selected", optionId: request.options.find((option) => option.kind === "reject_once")!.optionId },
    }));
    await chat.prompt([{ type: "text", text: "tool again" }]);
    expect(seen.items().filter((item) => item.kind === "tool").at(-1)).toMatchObject({ status: "failed" });
    chat.close();
  });

  it("stops a turn when asked", async () => {
    const agent = runFakeAgent();
    const seen = collector();
    const chat = await openChat(agent.stream, seen.handlers, OPTIONS);
    const turn = chat.prompt([{ type: "text", text: "be slow" }]);
    await new Promise((done) => setTimeout(done, 100));
    await chat.cancel();
    expect(await turn).toBe("cancelled");
    chat.close();
  });

  it("sends attachments as embedded resources the agent receives", async () => {
    const agent = runFakeAgent();
    const seen = collector();
    const chat = await openChat(agent.stream, seen.handlers, OPTIONS);
    await chat.prompt([
      { type: "text", text: "what did I attach?" },
      { type: "resource", resource: { uri: "studio://operation/GET%20%2Forders", mimeType: "text/plain", text: "GET /orders" } },
    ]);
    const reply = seen.items().find((item) => item.kind === "agent");
    expect(reply?.kind === "agent" && reply.text).toContain("Received 2 blocks: text, resource studio://operation/GET%20%2Forders");
    chat.close();
  });

  it("recognises an agent that needs signing in", async () => {
    const agent = runFakeAgent({ FAKE_ACP_AUTH: "1" });
    const error = await openChat(agent.stream, collector().handlers, OPTIONS).catch((caught: unknown) => caught);
    expect(isAuthRequired(error)).toBe(true);
  });

  it("fails clearly when the agent ends before answering", async () => {
    const session = nextSession++;
    const agent = connectProcess({ session, command: "x", cwd: "/" }, async () => undefined, {
      stop: async () => undefined,
      stderr: async () => "",
    });
    __events.deliverExit(session, { code: 1, stderr: "boom" });
    expect(await agent.exited).toEqual({ code: 1, stderr: "boom" });
    await expect(openChat(agent.stream, collector().handlers, OPTIONS)).rejects.toBeTruthy();
  });
});

describe("lines that arrive before anyone listens", () => {
  it("are kept and delivered in order, along with an early exit", async () => {
    const session = nextSession++;
    __events.deliverLine(session, JSON.stringify({ jsonrpc: "2.0", method: "a" }));
    __events.deliverLine(session, "not json, ignored");
    __events.deliverLine(session, JSON.stringify({ jsonrpc: "2.0", method: "b" }));
    __events.deliverExit(session, { code: 0, stderr: "" });
    const agent = connectProcess({ session, command: "x", cwd: "/" }, async () => undefined, {
      stop: async () => undefined,
      stderr: async () => "",
    });
    const reader = agent.stream.readable.getReader();
    const methods: string[] = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      methods.push((value as { method: string }).method);
    }
    expect(methods).toEqual(["a", "b"]);
    expect(await agent.exited).toEqual({ code: 0, stderr: "" });
  });
});
