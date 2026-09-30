import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { logMcpCall } from "./appConsole";
import { currentVersion } from "./appUpdates";
import * as library from "./library";
import { runTool, type ToolDeps } from "./mcp";
import { inTauri } from "./request";
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
/** Fired on `window` when a tool changed the library file, so the interface reloads it. */
export const LIBRARY_CHANGED_EVENT = "studio:library-changed";

export interface McpPrefs {
  /** Per-install bearer token. Empty until first needed. */
  token: string;
  port: number;
  /** Start the server when Studio opens. Off by default. */
  startOnLaunch: boolean;
}

export const DEFAULT_MCP_PREFS: McpPrefs = { token: "", port: DEFAULT_MCP_PORT, startOnLaunch: false };

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
  };
  if (!prefs.token) {
    prefs.token = newToken();
    await saveMcpPrefs(prefs);
  }
  return prefs;
}

export async function saveMcpPrefs(prefs: McpPrefs): Promise<void> {
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

interface CallPayload {
  id: number;
  name: string;
  arguments: unknown;
}

let bridge: Promise<UnlistenFn> | null = null;
let activity: Promise<UnlistenFn> | null = null;

/**
 * Answer `studio://mcp-call` events from the Rust server. Registered once per
 * page load; harmless when the server isn't running, since nothing then asks.
 */
export function ensureBridge(): Promise<UnlistenFn> {
  if (!inTauri) return Promise.resolve(() => {});
  // Calls Rust answers itself (list_environments) are only reported, for the console.
  activity ??= listen<{ name: string; ok: boolean }>("studio://mcp-activity", (event) =>
    logMcpCall(event.payload.name, event.payload.ok),
  );
  bridge ??= listen<CallPayload>("studio://mcp-call", (event) => {
    const { id, name, arguments: args } = event.payload;
    void runTool(name, args, deps).then((result) => {
      // The console gets the tool's name and outcome, never its arguments.
      logMcpCall(name, !result.isError);
      return invoke("mcp_respond", { id, result });
    });
  });
  return bridge;
}

