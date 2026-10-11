// Must come before the ACP library; see the module.
import "./zodJitless";
import * as acp from "@agentclientprotocol/sdk";
import type {
  ContentBlock,
  InitializeResponse,
  McpServer,
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
  StopReason,
  Stream,
  ToolCallContent,
} from "@agentclientprotocol/sdk";

/**
 * Talking to a coding agent over the Agent Client Protocol (ACP), for the chat
 * panel. The agent is a process on this machine that the user signed in to
 * themselves; Studio sends it what the user types, shows what comes back, and
 * answers its permission requests with what the user chose.
 *
 * Studio offers the agent no file system and no terminal of its own: those
 * client capabilities are declined, so the agent uses its own tools and asks
 * before it does anything that needs asking. Studio's tools reach it through
 * the local MCP server, when that's running.
 */

/** How long an agent gets to start and answer `initialize`. The first start of an adapter through npx downloads it. */
export const START_TIMEOUT_MS = 180_000;
/** How long creating a session may take. Agents connect to MCP servers here. */
export const SESSION_TIMEOUT_MS = 120_000;

export const CLIENT_INFO = { name: "spec0-studio", title: "Spec0 Studio" } as const;

// The conversation, as the panel shows it

export interface PlanEntryView {
  content: string;
  status: string;
}

export type ChatItem =
  | { kind: "user"; id: string; text: string; mentions: string[] }
  | { kind: "agent"; id: string; text: string; messageId?: string | null }
  | { kind: "thought"; id: string; text: string }
  | {
      kind: "tool";
      id: string;
      toolCallId: string;
      title: string;
      toolKind?: string;
      status: string;
      input?: string;
      output?: string;
      locations?: string[];
    }
  | { kind: "plan"; id: string; entries: PlanEntryView[] }
  | {
      kind: "permission";
      id: string;
      title: string;
      options: PermissionOption[];
      state: "pending" | "answered" | "cancelled";
      chosen?: string;
    }
  | { kind: "notice"; id: string; level: "info" | "error"; text: string };

/** Longest tool input or output kept for showing. */
export const MAX_TOOL_TEXT = 8000;

let nextItem = 1;
export function itemId(): string {
  return `i${Date.now().toString(36)}${(nextItem++).toString(36)}`;
}

export function clip(text: string, max = MAX_TOOL_TEXT): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
}

function stringify(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return clip(value);
  try {
    return clip(JSON.stringify(value, null, 2));
  } catch {
    return undefined;
  }
}

/** A content block as text: text as it is, anything else as a short label. */
export function blockText(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "resource_link":
      return `[${block.name || block.uri}]`;
    case "resource":
      return "text" in block.resource ? block.resource.text : `[${block.resource.uri}]`;
    case "image":
      return "[image]";
    case "audio":
      return "[audio]";
    default:
      return "";
  }
}

function toolContentText(content: ToolCallContent[] | undefined): string | undefined {
  if (!content?.length) return undefined;
  const parts = content.map((part) => {
    if (part.type === "content") return blockText(part.content);
    if (part.type === "diff") return `Changes ${part.path}`;
    return "Terminal output";
  });
  return clip(parts.filter(Boolean).join("\n"));
}

/**
 * Add streamed text to the message it belongs to: the last item, when it's the
 * same kind and, for agent messages that carry an id, the same message.
 */
function appendText(items: ChatItem[], kind: "agent" | "thought", text: string, messageId?: string | null): ChatItem[] {
  const last = items[items.length - 1];
  if (last?.kind === "thought" && kind === "thought") {
    return [...items.slice(0, -1), { ...last, text: last.text + text }];
  }
  if (last?.kind === "agent" && kind === "agent" && (!messageId || !last.messageId || last.messageId === messageId)) {
    return [...items.slice(0, -1), { ...last, text: last.text + text, messageId: last.messageId ?? messageId }];
  }
  const item: ChatItem =
    kind === "agent" ? { kind, id: itemId(), text, messageId: messageId ?? null } : { kind, id: itemId(), text };
  return [...items, item];
}

/**
 * Fold one `session/update` into the conversation. Kinds the panel doesn't
 * show (usage, available commands, modes) leave it as it was.
 */
export function applyUpdate(items: ChatItem[], update: SessionUpdate): ChatItem[] {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return appendText(items, "agent", blockText(update.content), update.messageId);
    case "agent_thought_chunk":
      return appendText(items, "thought", blockText(update.content));
    case "tool_call": {
      const existing = items.findIndex((item) => item.kind === "tool" && item.toolCallId === update.toolCallId);
      const tool: ChatItem = {
        kind: "tool",
        id: existing >= 0 ? items[existing].id : itemId(),
        toolCallId: update.toolCallId,
        title: update.title || "Tool call",
        toolKind: update.kind,
        status: update.status ?? "pending",
        input: stringify(update.rawInput),
        output: toolContentText(update.content) ?? stringify(update.rawOutput),
        locations: update.locations?.map((location) => location.path),
      };
      return existing >= 0 ? items.map((item, index) => (index === existing ? tool : item)) : [...items, tool];
    }
    case "tool_call_update": {
      const index = items.findIndex((item) => item.kind === "tool" && item.toolCallId === update.toolCallId);
      const base: Extract<ChatItem, { kind: "tool" }> =
        index >= 0
          ? (items[index] as Extract<ChatItem, { kind: "tool" }>)
          : { kind: "tool", id: itemId(), toolCallId: update.toolCallId, title: "Tool call", status: "pending" };
      const next: ChatItem = {
        ...base,
        title: update.title || base.title,
        toolKind: update.kind ?? base.toolKind,
        status: update.status ?? base.status,
        input: update.rawInput !== undefined ? stringify(update.rawInput) : base.input,
        output: toolContentText(update.content ?? undefined) ?? stringify(update.rawOutput) ?? base.output,
        locations: update.locations ? update.locations.map((location) => location.path) : base.locations,
      };
      return index >= 0 ? items.map((item, i) => (i === index ? next : item)) : [...items, next];
    }
    case "plan": {
      const entries = update.entries.map((entry) => ({ content: entry.content, status: entry.status }));
      // One plan per turn: a newer plan replaces the one since the last message from the user.
      const lastUser = items.map((item) => item.kind).lastIndexOf("user");
      const index = items.findIndex((item, i) => i > lastUser && item.kind === "plan");
      if (index >= 0) return items.map((item, i) => (i === index ? { ...item, entries } : item)) as ChatItem[];
      return [...items, { kind: "plan", id: itemId(), entries }];
    }
    case "notice": {
      const text = [update.title, update.description].filter(Boolean).join(": ");
      return [...items, { kind: "notice", id: itemId(), level: update.severity === "error" ? "error" : "info", text }];
    }
    default:
      return items;
  }
}

// Errors

/** ACP's "authentication required" error code. */
export const AUTH_REQUIRED = -32000;

export function isAuthRequired(error: unknown): boolean {
  return error instanceof acp.RequestError
    ? error.code === AUTH_REQUIRED
    : typeof error === "object" && error !== null && (error as { code?: unknown }).code === AUTH_REQUIRED;
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return String(error);
}

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, fail) => {
    timer = setTimeout(() => fail(new Error(message)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

// The connection

export interface StudioMcp {
  url: string;
  token: string;
}

export interface ChatHandlers {
  onUpdate: (update: SessionUpdate) => void;
  /** Ask the user. Resolve with their choice, or `cancelled`. */
  onPermission: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
}

export interface OpenOptions {
  /** The folder the agent works in. Absolute. */
  cwd: string;
  /** Studio's local MCP server, when it's running. */
  mcp: StudioMcp | null;
  studioVersion: string;
  startTimeoutMs?: number;
}

/** How Studio's tools reached the agent, for the panel to say. */
export type McpLink = "connected" | "server-off" | "unsupported";

export interface AgentChat {
  sessionId: string;
  agent: { name: string; title: string; version: string };
  mcp: McpLink;
  /** The agent can take embedded text resources, so attachments can go as files. */
  embeddedContext: boolean;
  prompt: (blocks: ContentBlock[]) => Promise<StopReason>;
  /** Ask the agent to stop the current turn. */
  cancel: () => Promise<void>;
  close: () => void;
}

/** The MCP server entry for `session/new`: Studio's local server, with its token. */
export function studioMcpServer(mcp: StudioMcp): McpServer {
  return {
    type: "http",
    name: "spec0-studio",
    url: mcp.url,
    headers: [{ name: "Authorization", value: `Bearer ${mcp.token}` }],
  };
}

/** Connect to an agent over `stream`, initialize, and start one session. */
export async function openChat(stream: Stream, handlers: ChatHandlers, options: OpenOptions): Promise<AgentChat> {
  const app = acp
    .client({ name: CLIENT_INFO.name })
    .onRequest(acp.methods.client.session.requestPermission, (ctx) => handlers.onPermission(ctx.params))
    .onNotification(acp.methods.client.session.update, (ctx) => handlers.onUpdate(ctx.params.update));
  const connection = app.connect(stream);
  const agent = connection.agent;

  try {
    const init: InitializeResponse = await withTimeout(
      agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: { ...CLIENT_INFO, version: options.studioVersion },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }),
      options.startTimeoutMs ?? START_TIMEOUT_MS,
      "The agent didn't answer in time.",
    );

    const httpMcp = Boolean(init.agentCapabilities?.mcpCapabilities?.http);
    const mcp: McpLink = !options.mcp ? "server-off" : httpMcp ? "connected" : "unsupported";
    const mcpServers = options.mcp && httpMcp ? [studioMcpServer(options.mcp)] : [];

    const session = await withTimeout(
      agent.request(acp.methods.agent.session.new, { cwd: options.cwd, mcpServers }),
      SESSION_TIMEOUT_MS,
      "The agent didn't start a session in time.",
    );

    const info = init.agentInfo;
    return {
      sessionId: session.sessionId,
      agent: { name: info?.name ?? "agent", title: info?.title ?? info?.name ?? "Agent", version: info?.version ?? "" },
      mcp,
      embeddedContext: Boolean(init.agentCapabilities?.promptCapabilities?.embeddedContext),
      prompt: async (blocks) => {
        const response = await agent.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: blocks,
        });
        return response.stopReason;
      },
      cancel: () => agent.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId }),
      close: () => connection.close(),
    };
  } catch (error) {
    connection.close();
    throw error;
  }
}
