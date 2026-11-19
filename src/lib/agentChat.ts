import { dump as dumpYaml } from "js-yaml";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { AgentId } from "./acpProcess";
import type { ChatItem } from "./acpClient";
import { redactStep, type Collection, type CollectionStep } from "./collection";
import type { HistoryEntry } from "./history";
import { responseFromHistory } from "./response";
import { redact, redactDeep, redactHeaders } from "./redact";
import type { ResponseResult } from "./request";
import { runLogText, type RunLog } from "./runLog";
import type { OperationSpec } from "./spec";
import { readStore, writeStore } from "./store";
import studioTools from "./mcp-tools.json";

/**
 * The chat panel's settings, what can be attached to a message, and the
 * conversations kept on this machine.
 *
 * Everything an agent is sent from Studio goes through `redact` first, and so
 * does everything kept on disk: a secret value is replaced by its `{{name}}`.
 */

export const AGENT_CHAT_STORE = "agent-chat.json";
export const AGENT_SESSIONS_STORE = "agent-sessions.json";
/** Fired on `window` when the chat settings change, so every view of them reloads. */
export const AGENT_CHAT_PREFS_EVENT = "studio:agent-chat-prefs";

export interface AgentChatPrefs {
  /** The agent to use. Null until the user picks one: the panel is off until then. */
  agent: AgentId | null;
  /** The folder the agent works in. Null for Studio's own empty folder. */
  workspace: string | null;
  /**
   * Give the agent Studio's tools: start the local MCP server when a chat
   * starts, if it isn't running, and connect the agent to it. On unless turned off.
   */
  studioTools: boolean;
  /** Give the agent Studio's instructions and task guides. On unless turned off. */
  instructions: boolean;
}

export const DEFAULT_AGENT_CHAT_PREFS: AgentChatPrefs = {
  agent: null,
  workspace: null,
  studioTools: true,
  instructions: true,
};

const AGENT_IDS: ReadonlyArray<AgentId> = ["claude", "codex", "gemini", "custom"];

export async function loadAgentChatPrefs(): Promise<AgentChatPrefs> {
  const stored = await readStore<Partial<AgentChatPrefs>>(AGENT_CHAT_STORE, {});
  return {
    agent: AGENT_IDS.includes(stored.agent as AgentId) ? (stored.agent as AgentId) : null,
    workspace: typeof stored.workspace === "string" && stored.workspace.trim() ? stored.workspace : null,
    // Only an explicit `false` turns it off.
    studioTools: stored.studioTools !== false,
    instructions: stored.instructions !== false,
  };
}

export async function saveAgentChatPrefs(prefs: AgentChatPrefs): Promise<void> {
  await writeStore(AGENT_CHAT_STORE, prefs);
}

// Attachments

export type MentionKind = "operation" | "response" | "step" | "run";

export interface Mention {
  /** Stable for the thing it points at, so it can't be attached twice. */
  id: string;
  kind: MentionKind;
  /** What the chip and the menu say. */
  label: string;
  /** Where it comes from, for the menu: the API or the collection. */
  detail?: string;
  /** The text sent to the agent. Already redacted. */
  text: string;
}

/** Longest attachment sent. A long response body is cut, and says so. */
export const MAX_MENTION_CHARS = 40_000;

function cut(text: string, max = MAX_MENTION_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}\n… (cut: ${text.length - max} more characters)` : text;
}

function dump(value: unknown): string {
  return dumpYaml(value, { lineWidth: 120, noRefs: true, skipInvalid: true }).trimEnd();
}

/** An operation from the open spec: what it takes and what it returns. */
export function operationMention(apiTitle: string, op: OperationSpec): Mention {
  const label = `${op.method.toUpperCase()} ${op.path}`;
  const described = {
    api: apiTitle,
    operation: label,
    operationId: op.operationId,
    summary: op.summary,
    description: op.description,
    deprecated: op.deprecated || undefined,
    parameters: op.parameters.length ? op.parameters : undefined,
    requestBody: op.requestBody
      ? { required: op.requestBody.required, contentType: op.requestBody.contentType, schema: op.requestBody.schema }
      : undefined,
    responses: op.responses,
    security: op.security,
  };
  return {
    id: `operation:${apiTitle}:${op.id}`,
    kind: "operation",
    label,
    detail: apiTitle,
    text: cut(redact(dump(described))),
  };
}

/** The response on screen, with the request it answered. */
export function responseMention(
  request: { method: string; url: string },
  response: ResponseResult,
  sentAt?: string,
): Mention {
  const label = `Response ${response.status} · ${request.method.toUpperCase()} ${redact(request.url)}`;
  const body = response.binary
    ? `(${response.binary.contentType}, ${response.binary.byteLength} bytes, not text)`
    : response.bodyText;
  const text = [
    `${request.method.toUpperCase()} ${request.url}`,
    `Status: ${response.status} ${response.statusText}`.trim(),
    `Time: ${response.ms} ms`,
    ...(sentAt ? [`Sent: ${sentAt}`] : []),
    "",
    "Headers:",
    ...Object.entries(redactHeaders(response.headers)).map(([name, value]) => `${name}: ${value}`),
    "",
    "Body:",
    body,
  ].join("\n");
  return { id: `response:${request.method}:${request.url}:${sentAt ?? ""}`, kind: "response", label, text: cut(redact(text)) };
}

/** A collection step as it's written in a collection file, with literal auth values left out. */
export function stepMention(collection: Pick<Collection, "id" | "name">, step: CollectionStep): Mention {
  const { step: clean } = redactStep(step);
  const label = step.name?.trim() || step.key;
  return {
    id: `step:${collection.id}:${step.key}`,
    kind: "step",
    label,
    detail: collection.name,
    text: cut(redact(`Collection: ${collection.name}\nStep: ${step.key}\n\n${dump(redactDeep(clean))}`)),
  };
}

/** A collection run's log: each step, what was sent, what came back, and why it failed. */
export function runMention(log: RunLog): Mention {
  return {
    id: `run:${log.collection.id}:${log.id}`,
    kind: "run",
    label: `Run of ${log.collection.name}`,
    detail: log.startedAt,
    text: cut(redact(runLogText(log))),
  };
}

/** Something that can be attached, built only when it's picked. */
export interface MentionChoice {
  id: string;
  kind: MentionKind;
  label: string;
  detail?: string;
  build: () => Mention;
}

export interface MentionSources {
  /** The open API: its operations, and the one on screen first. */
  api?: { title: string; operations: OperationSpec[]; current?: OperationSpec | null } | null;
  /** Requests sent, newest first. */
  history: HistoryEntry[];
  collections: Collection[];
  /** A collection's runs, newest first. */
  runsFor: (collectionId: string) => RunLog[];
}

export const MAX_RECENT_RESPONSES = 5;
export const MAX_RUNS_PER_COLLECTION_SHOWN = 3;

/** Everything the @ menu offers, in the order it's listed. */
export function mentionChoices(sources: MentionSources): MentionChoice[] {
  const choices: MentionChoice[] = [];
  const api = sources.api;
  if (api) {
    const ordered = api.current
      ? [api.current, ...api.operations.filter((op) => op.id !== api.current!.id)]
      : api.operations;
    for (const op of ordered) {
      choices.push({
        id: `operation:${api.title}:${op.id}`,
        kind: "operation",
        label: `${op.method.toUpperCase()} ${op.path}`,
        detail: op.summary ? `${api.title} · ${op.summary}` : api.title,
        build: () => operationMention(api.title, op),
      });
    }
  }
  for (const entry of sources.history.filter((entry) => entry.responseBody !== undefined).slice(0, MAX_RECENT_RESPONSES)) {
    const response = responseFromHistory(entry);
    if (!response) continue;
    choices.push({
      id: `response:${entry.id}`,
      kind: "response",
      label: `Response ${entry.status} · ${entry.method.toUpperCase()} ${entry.path}`,
      detail: `${entry.specTitle} · ${entry.at}`,
      build: () => ({ ...responseMention({ method: entry.method, url: entry.url }, response, entry.at), id: `response:${entry.id}` }),
    });
  }
  for (const collection of sources.collections) {
    for (const step of collection.steps) {
      choices.push({
        id: `step:${collection.id}:${step.key}`,
        kind: "step",
        label: step.name?.trim() || step.key,
        detail: collection.name,
        build: () => stepMention(collection, step),
      });
    }
  }
  for (const collection of sources.collections) {
    for (const log of sources.runsFor(collection.id).slice(0, MAX_RUNS_PER_COLLECTION_SHOWN)) {
      choices.push({
        id: `run:${collection.id}:${log.id}`,
        kind: "run",
        label: `Run of ${collection.name}`,
        detail: log.startedAt,
        build: () => runMention(log),
      });
    }
  }
  return choices;
}

/** Choices whose label or detail contain every word typed. */
export function filterChoices(choices: MentionChoice[], query: string): MentionChoice[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return choices;
  return choices.filter((choice) => {
    const haystack = `${choice.kind} ${choice.label} ${choice.detail ?? ""}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

// What's open in Studio

/** What the developer has open, for the note at the start of a chat and the suggestions. */
export interface StudioContext {
  api?: { title: string; version?: string } | null;
  operation?: { method: string; path: string; summary?: string } | null;
  collection?: { name: string; steps: number; lastRun?: "passed" | "failed" | null } | null;
}

export const STUDIO_CONTEXT_URI = "studio://context";

/** How a collection's last run went: failed when a step failed or it stopped early. Null while it runs, or before any. */
export function runOutcome(log: Pick<RunLog, "finishedAt" | "counts" | "stoppedEarly"> | undefined): "passed" | "failed" | null {
  if (!log?.finishedAt || !log.counts) return null;
  return log.counts.failed > 0 || log.stoppedEarly ? "failed" : "passed";
}

/**
 * The note the first message of each chat carries: where the agent is, which
 * tools it has, and what's open. Short, and redacted like everything else.
 */
export function studioContextNote(context: StudioContext, toolsConnected: boolean): string {
  const lines = [
    "You're talking to a developer inside Spec0 Studio, a desktop app for calling and testing APIs from their OpenAPI specs.",
    toolsConnected
      ? "Studio's tools are available to you in the MCP server named spec0-studio. Use them to look up the APIs in Studio, send requests, check responses against the spec, start local mocks, and build and run collections, rather than calling APIs some other way. The developer approves requests and other actions in Studio. Environment values appear as {{name}}; you never see secret values."
      : "Studio's tools aren't connected in this chat, so describe what to do in Studio instead of calling them.",
  ];
  const open: string[] = [];
  if (context.api) open.push(`- API: ${context.api.title}${context.api.version ? ` ${context.api.version}` : ""}`);
  if (context.operation) {
    const { method, path, summary } = context.operation;
    open.push(`- Operation: ${method.toUpperCase()} ${path}${summary ? ` (${summary})` : ""}`);
  }
  if (context.collection) {
    const { name, steps, lastRun } = context.collection;
    open.push(
      `- Collection: ${name} (${steps} step${steps === 1 ? "" : "s"}${lastRun ? `, last run ${lastRun}` : ""})`,
    );
  }
  lines.push(open.length ? `Open in Studio right now:\n${open.join("\n")}` : "Nothing in particular is open in Studio right now.");
  return redact(lines.join("\n\n"));
}

/** The note as a block: an embedded resource when the agent takes them, otherwise text. */
export function contextBlock(note: string, embedded: boolean): ContentBlock {
  return embedded
    ? { type: "resource", resource: { uri: STUDIO_CONTEXT_URI, mimeType: "text/plain", text: redact(note) } }
    : { type: "text", text: `Context from Spec0 Studio:\n\n${redact(note)}` };
}

/** A few things to ask in an empty chat, from what's open. Plain, and at most four. */
export function chatSuggestions(context: StudioContext): string[] {
  const out: string[] = [];
  const { api, operation, collection } = context;
  if (operation) out.push(`Send ${operation.method.toUpperCase()} ${operation.path} and check the response against the spec`);
  if (api) {
    out.push(`Test the ${api.title} against a local mock`);
    out.push(`Build a collection that walks through the main flow of the ${api.title}`);
  }
  if (collection) {
    out.push(
      collection.lastRun === "failed"
        ? `Why did the last run of ${collection.name} fail?`
        : `Run ${collection.name} and explain anything that fails`,
    );
  }
  if (!out.length) {
    out.push("Which APIs do I have in Studio?");
    out.push("Start a local mock of one of my APIs and send it a request");
  }
  return [...new Set(out)].slice(0, 4);
}

// Studio tool calls in the conversation

/** A tool card for one of Studio's tools that made something the developer can open. */
export interface StudioLink {
  tool: "create_collection" | "run_collection";
  /** The collection's id, or its name when only that is known. */
  collection: string;
  runId?: string;
}

/** The tool's name anywhere in the card's title or input: agents prefix it differently (`mcp__spec0-studio__…`, `spec0-studio/…`). */
const LINKED_TOOLS = /(?<![a-z])(create_collection|run_collection)(?![a-z])/;

/** Every JSON object in a tool's output, including JSON carried inside strings (as agents often wrap it). */
function objectsIn(value: unknown, found: Record<string, unknown>[] = [], depth = 0): Record<string, unknown>[] {
  if (depth > 6) return found;
  if (typeof value === "string") {
    const start = value.indexOf("{");
    const end = value.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        objectsIn(JSON.parse(value.slice(start, end + 1)), found, depth + 1);
      } catch {
        // Not JSON; nothing to find in it.
      }
    }
  } else if (Array.isArray(value)) {
    for (const entry of value) objectsIn(entry, found, depth + 1);
  } else if (value && typeof value === "object") {
    found.push(value as Record<string, unknown>);
    for (const entry of Object.values(value)) objectsIn(entry, found, depth + 1);
  }
  return found;
}

/**
 * The collection a finished `create_collection` or `run_collection` call made
 * or ran, read from what the card shows. Null for any other tool, a call that
 * hasn't finished, or output Studio doesn't recognise.
 */
export function studioLinkFor(item: Extract<ChatItem, { kind: "tool" }>): StudioLink | null {
  if (item.status !== "completed") return null;
  const tool = LINKED_TOOLS.exec(`${item.title}\n${item.input ?? ""}`)?.[1] as StudioLink["tool"] | undefined;
  if (!tool) return null;
  const objects = objectsIn(item.output ?? "");
  if (tool === "create_collection") {
    const made = objects.find((object) => typeof object.id === "string" && object.id.startsWith("col_") && object.draft === true);
    return made ? { tool, collection: made.id as string } : null;
  }
  const run = objects.find((object) => typeof object.runId === "string" && typeof object.collection === "string");
  return run ? { tool, collection: run.collection as string, runId: run.runId as string } : null;
}

const STUDIO_TOOL_NAMES = new Set((studioTools as Array<{ name: string }>).map((tool) => tool.name));

/**
 * Which of Studio's own tools a tool call used, read from its title or input
 * (agents name them differently: `mcp__spec0-studio__run_collection`,
 * `spec0-studio/run_collection`, or only in the input). Null for any other tool.
 */
export function studioToolName(item: Extract<ChatItem, { kind: "tool" }>): string | null {
  for (const text of [item.title, item.input ?? ""]) {
    for (const word of text.match(/[a-z][a-z0-9]*(?:_[a-z0-9]+)+/g) ?? []) {
      if (STUDIO_TOOL_NAMES.has(word)) return word;
    }
  }
  return null;
}

/** A tool call's title in words: a bare tool id reads as "Run collection". */
export function toolCallTitle(item: Extract<ChatItem, { kind: "tool" }>): string {
  const name = studioToolName(item);
  const bare = /^(?:tool:\s*)?[\w.-]*?(?:__|\/)?[a-z0-9_]+$/i.test(item.title.trim());
  if (!name || !bare || !item.title.includes(name)) return item.title;
  const words = name.replace(/_/g, " ");
  return words[0].toUpperCase() + words.slice(1);
}

/**
 * What a message is sent as: the Studio note when there is one, the text, then
 * each attachment. As embedded resources when the agent takes them, otherwise
 * as text with a heading.
 */
export function promptBlocks(text: string, mentions: Mention[], embedded: boolean, context?: string): ContentBlock[] {
  const blocks: ContentBlock[] = [
    ...(context ? [contextBlock(context, embedded)] : []),
    { type: "text", text: redact(text) },
  ];
  for (const mention of mentions) {
    const body = redact(mention.text);
    if (embedded) {
      blocks.push({
        type: "resource",
        resource: {
          uri: `studio://${mention.kind}/${encodeURIComponent(mention.label)}`,
          mimeType: "text/plain",
          text: body,
        },
      });
    } else {
      blocks.push({ type: "text", text: `Attached from Spec0 Studio, ${mention.kind}: ${mention.label}\n\n${body}` });
    }
  }
  return blocks;
}

// Kept conversations

export interface SavedChat {
  id: string;
  agent: AgentId;
  agentName: string;
  /** The first thing the user wrote. */
  title: string;
  startedAt: string;
  updatedAt: string;
  items: ChatItem[];
}

export interface SavedChats {
  version: 1;
  chats: SavedChat[];
}

export const EMPTY_SAVED_CHATS: SavedChats = { version: 1, chats: [] };
export const MAX_SAVED_CHATS = 30;
/** Rough limit on the whole file, so a long-lived install doesn't grow it without end. */
export const MAX_SAVED_CHARS = 1_500_000;

export function chatTitle(items: ChatItem[]): string {
  const first = items.find((item) => item.kind === "user");
  const text = first?.kind === "user" ? first.text.trim().split("\n")[0] : "";
  return text ? (text.length > 80 ? `${text.slice(0, 77)}…` : text) : "New chat";
}

/** A conversation as it's kept: redacted, and no question left open. */
export function toSaved(chat: SavedChat): SavedChat {
  const items = chat.items.map((item) =>
    item.kind === "permission" && item.state === "pending" ? { ...item, state: "cancelled" as const } : item,
  );
  return redactDeep({ ...chat, title: chatTitle(items), items });
}

/** Add or replace one conversation, newest first, within the limits. */
export function keepChat(store: SavedChats, chat: SavedChat): SavedChats {
  const saved = toSaved(chat);
  let chats = [saved, ...store.chats.filter((entry) => entry.id !== chat.id)].slice(0, MAX_SAVED_CHATS);
  while (chats.length > 1 && JSON.stringify(chats).length > MAX_SAVED_CHARS) chats = chats.slice(0, -1);
  return { version: 1, chats };
}

export function forgetChat(store: SavedChats, id: string): SavedChats {
  return { version: 1, chats: store.chats.filter((chat) => chat.id !== id) };
}

export async function loadSavedChats(): Promise<SavedChats> {
  const stored = await readStore<Partial<SavedChats>>(AGENT_SESSIONS_STORE, EMPTY_SAVED_CHATS);
  return stored.version === 1 && Array.isArray(stored.chats) ? { version: 1, chats: stored.chats } : EMPTY_SAVED_CHATS;
}

export async function saveSavedChats(store: SavedChats): Promise<void> {
  await writeStore(AGENT_SESSIONS_STORE, store);
}
