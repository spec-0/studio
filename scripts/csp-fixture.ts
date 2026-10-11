/**
 * Exercised by `scripts/csp-check.mjs` inside a browser running the app's real
 * content security policy. Kept deliberately small: it must fail for one reason
 * only: that something in the validation path, in opening a Swagger 2.0
 * spec, or in reading the chat panel's agent messages, needs eval.
 */
import { applyUpdate, openChat, type ChatItem } from "../src/lib/acpClient";
import { validateResponse } from "../src/lib/validate";
import { openapiText, parseSpec, type Json } from "../src/lib/spec";

const doc = {
  openapi: "3.0.3",
  components: {
    schemas: {
      Customer: {
        type: "object",
        required: ["email"],
        properties: { email: { type: "string" } },
      },
      Order: {
        type: "object",
        required: ["id", "amount", "customer"],
        properties: {
          id: { type: "string" },
          amount: { type: "integer" },
          customer: { $ref: "#/components/schemas/Customer" },
        },
      },
    },
  },
} as unknown as Json;

const schema = (doc as Record<string, any>).components.schemas.Order as Json;

/** Open a Swagger 2.0 YAML spec (converted on the way in) and check a response against it. */
function swagger2() {
  try {
    const spec = parseSpec(
      [
        "swagger: '2.0'",
        "info: {title: Orders, version: '1'}",
        "host: api.example.com",
        "schemes: [https]",
        "paths:",
        "  /orders/{id}:",
        "    get:",
        "      parameters: [{name: id, in: path, required: true, type: string}]",
        "      responses:",
        "        '200': {description: OK, schema: {$ref: '#/definitions/Order'}}",
        "definitions:",
        "  Order: {type: object, required: [id], properties: {id: {type: string}}}",
        "",
      ].join("\n"),
      "orders.yaml",
    );
    const schema = spec.operations[0]?.responses[0]?.schema;
    return {
      converted: spec.converted?.from ?? null,
      operations: spec.operations.length,
      text: openapiText(spec).startsWith("openapi: 3.0.3"),
      validation: validateResponse(spec.doc, schema, { id: 7 }).status,
    };
  } catch (error) {
    return { error: String(error) };
  }
}

/**
 * A chat with a scripted agent, in memory. The ACP library checks every message
 * it reads, and its checker compiles with `new Function` unless told not to.
 */
async function acp() {
  type Message = { id?: number; method?: string };
  let push!: (message: unknown) => void;
  const readable = new ReadableStream({
    start(controller) {
      push = (message) => controller.enqueue(message);
    },
  });
  const writable = new WritableStream<Message>({
    write(message) {
      const reply = (result: unknown) => push({ jsonrpc: "2.0", id: message.id, result });
      if (message.method === "initialize") {
        reply({
          protocolVersion: 1,
          agentInfo: { name: "csp", title: "CSP agent", version: "1" },
          agentCapabilities: { mcpCapabilities: { http: true } },
        });
      } else if (message.method === "session/new") {
        reply({ sessionId: "s1" });
      } else if (message.method === "session/prompt") {
        push({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } },
        });
        reply({ stopReason: "end_turn" });
      }
    },
  });
  try {
    let items: ChatItem[] = [];
    const chat = await openChat(
      { readable, writable } as never,
      {
        onUpdate: (update) => {
          items = applyUpdate(items, update);
        },
        onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      },
      { cwd: "/", mcp: null, studioVersion: "0.0.0", startTimeoutMs: 5000 },
    );
    const stop = await chat.prompt([{ type: "text", text: "hi" }]);
    chat.close();
    const reply = items.find((item) => item.kind === "agent");
    return { stop, text: reply?.kind === "agent" ? reply.text : null, agent: chat.agent.title };
  } catch (error) {
    return { error: String(error) };
  }
}

void acp().then((result) => {
  (globalThis as Record<string, unknown>).__CSP_ACP__ = result;
});

(globalThis as Record<string, unknown>).__CSP_CHECK__ = {
  swagger2: swagger2(),
  valid: validateResponse(doc, schema, {
    id: "or_1",
    amount: 500,
    customer: { email: "a@b.c" },
  }),
  invalid: validateResponse(doc, schema, {
    id: 42,
    customer: { nickname: "x" },
    extra: true,
  }),
};
