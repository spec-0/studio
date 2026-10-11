#!/usr/bin/env node
/**
 * A stand-in coding agent that speaks the Agent Client Protocol over standard
 * input and output. It has no model: it answers in a fixed way, so the chat
 * panel can be tested without signing in to a real agent.
 *
 * The tests in `src/lib/__tests__/acpClient.test.ts` run it, and it can be set
 * as "Another agent" in Settings → Agent chat to try the panel by hand:
 *
 *   program:   the full path to `node`
 *   arguments: the full path to this file
 *
 * What it does with a message:
 *   - always: replies "You said: …", in two pieces, with a short plan
 *   - "tool":   shows a tool call and asks permission before finishing it
 *   - "mcp":    calls Studio's MCP server, if it was given one, and lists its tools
 *   - "slow":   waits until the turn is cancelled
 *   - "attach": says what kinds of content it received
 *
 * Set FAKE_ACP_AUTH=1 to have it ask for sign-in when a session starts.
 */
import { createInterface } from "node:readline";

const out = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const pending = new Map();
let nextId = 1000;
let mcpServers = [];
const cancelled = new Set();

function request(method, params) {
  const id = nextId++;
  out({ id, method, params });
  return new Promise((resolve) => pending.set(id, resolve));
}

const update = (sessionId, body) => out({ method: "session/update", params: { sessionId, update: body } });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function prompt(id, { sessionId, prompt: blocks }) {
  cancelled.delete(sessionId);
  const text = blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const said = text.split("\n")[0].slice(0, 200);

  update(sessionId, {
    sessionUpdate: "plan",
    entries: [{ content: "Read the message", priority: "medium", status: "completed" }],
  });
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "You said: " } });
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: said } });

  if (/attach/i.test(text)) {
    const kinds = blocks.map((block) => (block.type === "resource" ? `resource ${block.resource.uri}` : block.type));
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `\n\nReceived ${blocks.length} blocks: ${kinds.join(", ")}.` },
    });
  }

  if (/mcp/i.test(text)) {
    const server = mcpServers.find((entry) => entry.type === "http");
    let reply = "\n\nNo MCP server was given to me.";
    if (server) {
      const headers = Object.fromEntries(server.headers.map((header) => [header.name, header.value]));
      try {
        const response = await fetch(server.url, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        });
        const body = await response.json();
        const names = (body.result?.tools ?? []).map((tool) => tool.name);
        reply = `\n\nStudio's MCP server has ${names.length} tools: ${names.join(", ")}.`;
      } catch (error) {
        reply = `\n\nCouldn't reach the MCP server: ${error.message}`;
      }
    }
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } });
  }

  if (/tool/i.test(text)) {
    const toolCallId = `call_${nextId}`;
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId,
      title: "Read orders.yaml",
      kind: "read",
      status: "pending",
      rawInput: { path: "orders.yaml" },
    });
    const answer = await request("session/request_permission", {
      sessionId,
      toolCall: { toolCallId, title: "Read orders.yaml", kind: "read" },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    });
    const allowed = answer?.outcome?.outcome === "selected" && answer.outcome.optionId === "allow";
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: allowed ? "completed" : "failed",
      content: [{ type: "content", content: { type: "text", text: allowed ? "openapi: 3.1.0" : "Not allowed." } }],
    });
  }

  if (/slow/i.test(text)) {
    while (!cancelled.has(sessionId)) await sleep(20);
    out({ id, result: { stopReason: "cancelled" } });
    return;
  }

  out({ id, result: { stopReason: cancelled.has(sessionId) ? "cancelled" : "end_turn" } });
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id !== undefined && !message.method) {
    pending.get(message.id)?.(message.result);
    pending.delete(message.id);
    return;
  }
  switch (message.method) {
    case "initialize":
      out({
        id: message.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "fake-agent", title: "Fake agent", version: "1.0.0" },
          agentCapabilities: {
            loadSession: false,
            promptCapabilities: { embeddedContext: true },
            mcpCapabilities: { http: true, sse: false },
          },
          authMethods: [],
        },
      });
      break;
    case "session/new":
      if (process.env.FAKE_ACP_AUTH === "1") {
        out({ id: message.id, error: { code: -32000, message: "Authentication required" } });
        break;
      }
      mcpServers = message.params.mcpServers ?? [];
      out({ id: message.id, result: { sessionId: "sess_fake_1" } });
      break;
    case "session/prompt":
      void prompt(message.id, message.params);
      break;
    case "session/cancel":
      cancelled.add(message.params.sessionId);
      for (const [id, resolve] of pending) {
        resolve({ outcome: { outcome: "cancelled" } });
        pending.delete(id);
      }
      break;
    default:
      if (message.id !== undefined) {
        out({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
      }
  }
});
lines.on("close", () => process.exit(0));
