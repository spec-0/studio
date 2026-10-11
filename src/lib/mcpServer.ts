import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { agentApp } from "./agentApp";
import {
  currentStopGeneration,
  gateMockStart,
  gateRequest,
  gateSave,
  noteAgent,
  recordActivity,
  setAgentRules,
  stopAgents,
} from "./agentControl";
import { agentLabel, DEFAULT_AGENT_RULES, normaliseRules, type AgentRules } from "./agentPolicy";
import { logMcpCall } from "./appConsole";
import { currentVersion } from "./appUpdates";
import { readCollectionFile } from "./collectionFile";
import * as history from "./history";
import * as library from "./library";
import { runTool, type ToolDeps, type ToolResult } from "./mcp";
import { AGENT_TOOLS, runAgentTool, type AgentToolDeps } from "./mcpAgent";
import { redactDeep } from "./redact";
import { appFetch, inTauri, send } from "./request";
import { createMock, getMockApiKey, listMocks, listTeamApis, loadSession, refreshMock } from "./spec0";
import { readStore, writeStore } from "./store";

/**
 * Starting, stopping and configuring the local MCP server, and answering the
 * tool calls it forwards to the web view.
 *
 * The server is off unless the user starts it. It listens on 127.0.0.1 only and
 * requires a bearer token generated on this machine. See `src-tauri/src/mcp.rs`.
 */

export const MCP_STORE = "mcp.json";
/** The port tried first; the server moves to the next free one if it's taken. */
export const DEFAULT_MCP_PORT = 47321;
/**
 * Fired on `window` when a tool changed the library file, so the interface
 * reloads it. `detail.specChanged` is set when an API's spec text changed.
 */
export const LIBRARY_CHANGED_EVENT = "studio:library-changed";

export interface McpPrefs {
  /** Per-install bearer token. Empty until first needed. */
  token: string;
  port: number;
  /** Start the server when Studio opens. Off by default. */
  startOnLaunch: boolean;
  /** What agents may send: blocked hosts and the cap per minute. */
  agentRules: AgentRules;
}

export const DEFAULT_MCP_PREFS: McpPrefs = {
  token: "",
  port: DEFAULT_MCP_PORT,
  startOnLaunch: false,
  agentRules: DEFAULT_AGENT_RULES,
};

/** 32 random bytes from the web view's CSPRNG, base64url. */
export function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `s0mcp_${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

export function validPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port >= 1024 && port <= 65535;
}

/** Stored preferences, with a token generated (and saved) the first time. */
export async function loadMcpPrefs(): Promise<McpPrefs> {
  const stored = await readStore<Partial<McpPrefs>>(MCP_STORE, {});
  const prefs: McpPrefs = {
    token: typeof stored.token === "string" && stored.token.length >= 32 ? stored.token : "",
    port: validPort(stored.port) ? stored.port : DEFAULT_MCP_PORT,
    // Only an explicit `true` turns it on.
    startOnLaunch: stored.startOnLaunch === true,
    agentRules: normaliseRules(stored.agentRules),
  };
  setAgentRules(prefs.agentRules);
  if (!prefs.token) {
    prefs.token = newToken();
    await saveMcpPrefs(prefs);
  }
  return prefs;
}

export async function saveMcpPrefs(prefs: McpPrefs): Promise<void> {
  setAgentRules(prefs.agentRules);
  await writeStore(MCP_STORE, prefs);
}

export interface McpStatus {
  running: boolean;
  port: number | null;
}

const STOPPED: McpStatus = { running: false, port: null };

export async function mcpStatus(): Promise<McpStatus> {
  if (!inTauri) return STOPPED;
  try {
    return await invoke<McpStatus>("mcp_status");
  } catch {
    return STOPPED;
  }
}

/** Start (or restart) the server. Throws with a readable reason. */
export async function startMcp(prefs: McpPrefs): Promise<McpStatus> {
  if (!inTauri) throw new Error("The local MCP server needs the desktop app.");
  await ensureBridge();
  return invoke<McpStatus>("mcp_start", { port: prefs.port, token: prefs.token });
}

export async function stopMcp(): Promise<McpStatus> {
  if (!inTauri) return STOPPED;
  return invoke<McpStatus>("mcp_stop");
}

/**
 * Stop agents: refuse what they're waiting for, cancel runs they started,
 * forget what was allowed this session, and stop the server, which answers
 * every call still in flight. The developer starts it again when they want.
 */
export async function stopAllAgents(): Promise<McpStatus> {
  stopAgents();
  return stopMcp();
}

export function endpoint(port: number): string {
  return `http://127.0.0.1:${port}/mcp`;
}

/** Copy-paste setup for common clients. The token is in them, so they're shown masked until asked. */
export function setupSnippets(port: number, token: string): Array<{ id: string; label: string; text: string }> {
  const url = endpoint(port);
  const auth = `Bearer ${token}`;
  const server = { type: "http", url, headers: { Authorization: auth } };
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      text: `claude mcp add --transport http spec0-studio ${url} --header "Authorization: ${auth}"`,
    },
    {
      id: "cursor",
      label: "Cursor (.cursor/mcp.json)",
      text: JSON.stringify({ mcpServers: { "spec0-studio": { url, headers: { Authorization: auth } } } }, null, 2),
    },
    {
      id: "json",
      label: "Other clients (JSON)",
      text: JSON.stringify({ mcpServers: { "spec0-studio": server } }, null, 2),
    },
  ];
}

/** Replace every occurrence of the token, for showing a snippet on screen. */
export function maskToken(text: string, token: string): string {
  if (!token) return text;
  const masked = `${token.slice(0, 8)}${"•".repeat(12)}`;
  return text.split(token).join(masked);
}

// Answering tool calls

const deps: ToolDeps = {
  loadLibrary: library.loadLibrary,
  readSpecText: library.readSpecText,
  loadSession,
  studioVersion: currentVersion,
  listTeamApis,
  listMocks,
  createMock,
  refreshMock,
  getMockApiKey,
  setMock: library.setMock,
  libraryChanged: () => window.dispatchEvent(new Event(LIBRARY_CHANGED_EVENT)),
};

const agentDeps: AgentToolDeps = {
  app: agentApp,
  loadLibrary: library.loadLibrary,
  readSpecText: library.readSpecText,
  send: (plan, transport, meta) => send(plan, transport, meta),
  gateRequest,
  gateMockStart,
  gateSave,
  stopGeneration: currentStopGeneration,
  recordActivity,
  recordHistory: history.record,
  readFile: readCollectionFile,
  rereadFile: library.rereadFile,
  fetchText: async (url) => {
    const response = await appFetch(url);
    if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
    return response.text();
  },
  applyUpdate: library.applyUpdate,
  specChanged: (id) => window.dispatchEvent(new CustomEvent(LIBRARY_CHANGED_EVENT, { detail: { specChanged: id } })),
};

interface AgentInfo {
  name?: string | null;
  version?: string | null;
}

interface CallPayload {
  id: number;
  name: string;
  arguments: unknown;
  agent?: AgentInfo;
}

/** Answer one call, whichever module has the tool. Never throws. */
export async function answerCall(name: string, args: unknown, agent: string): Promise<ToolResult> {
  const result =
    name in AGENT_TOOLS ? await runAgentTool(name, args, agentDeps, { agent }) : await runTool(name, args, deps);
  // The last line of defence: whatever a tool built, no known secret value leaves Studio.
  return redactDeep(result);
}

/** The first line of a result, for the activity view. */
function firstLine(result: ToolResult): string {
  const line = result.content[0]?.text.split("\n").find((row) => row.trim() && !/^[{[]$/.test(row.trim())) ?? "";
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

let bridge: Promise<UnlistenFn> | null = null;
let activity: Promise<UnlistenFn> | null = null;
let clients: Promise<UnlistenFn> | null = null;

/**
 * Answer `studio://mcp-call` events from the Rust server. Registered once per
 * page load; harmless when the server isn't running, since nothing then asks.
 */
export function ensureBridge(): Promise<UnlistenFn> {
  if (!inTauri) return Promise.resolve(() => {});
  // Calls Rust answers itself (list_environments) are only reported, for the console.
  activity ??= listen<{ name: string; ok: boolean; agent?: AgentInfo }>("studio://mcp-activity", (event) => {
    const agent = agentLabel(event.payload.agent);
    logMcpCall(event.payload.name, event.payload.ok, agent);
    recordActivity({ agent, tool: event.payload.name, ok: event.payload.ok, summary: `${event.payload.name} (answered by Studio's shell)` });
  });
  clients ??= listen<AgentInfo>("studio://mcp-client", (event) => noteAgent(event.payload));
  bridge ??= listen<CallPayload>("studio://mcp-call", (event) => {
    const { id, name, arguments: args } = event.payload;
    const agent = agentLabel(event.payload.agent);
    void answerCall(name, args, agent).then((result) => {
      // The console gets the agent, the tool's name and outcome, never its arguments.
      logMcpCall(name, !result.isError, agent);
      recordActivity({ agent, tool: name, ok: !result.isError, summary: firstLine(result) });
      return invoke("mcp_respond", { id, result });
    });
  });
  return bridge;
}

