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
}

export const DEFAULT_AGENT_CHAT_PREFS: AgentChatPrefs = { agent: null, workspace: null };

const AGENT_IDS: ReadonlyArray<AgentId> = ["claude", "codex", "gemini", "custom"];

export async function loadAgentChatPrefs(): Promise<AgentChatPrefs> {
  const stored = await readStore<Partial<AgentChatPrefs>>(AGENT_CHAT_STORE, {});
  return {
    agent: AGENT_IDS.includes(stored.agent as AgentId) ? (stored.agent as AgentId) : null,
    workspace: typeof stored.workspace === "string" && stored.workspace.trim() ? stored.workspace : null,
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

/**
 * What a message is sent as: the text, then each attachment. As an embedded
 * resource when the agent takes them, otherwise as text with a heading.
 */
export function promptBlocks(text: string, mentions: Mention[], embedded: boolean): ContentBlock[] {
  const blocks: ContentBlock[] = [{ type: "text", text: redact(text) }];
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
