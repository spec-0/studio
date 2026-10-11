import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";
import { inTauri } from "./request";

/**
 * The agent process behind the chat panel, seen from the web view.
 *
 * Rust starts and stops the process and passes its lines through events (see
 * `src-tauri/src/acp.rs`). This turns that into the message stream the ACP
 * library reads and writes. The web view only ever names an agent; which
 * program runs is decided in Rust.
 */

export type AgentId = "claude" | "codex" | "gemini" | "custom";

export interface AgentInfo {
  id: AgentId;
  name: string;
  /** `installed`, `npx` (its adapter is fetched the first time), `chosen` or `missing`. */
  how: "installed" | "npx" | "chosen" | "missing";
  /** What will run. Empty when missing. */
  command: string;
  /** The program the user chose by hand, with its arguments, for editing. */
  chosen: { program: string; args: string[] } | null;
  /** The agent's own command line was found, for signing in to it. */
  cliFound: boolean;
  cli: string;
}

export interface AgentList {
  agents: AgentInfo[];
  /** The empty folder an agent works in unless another is chosen. */
  defaultWorkspace: string;
}

export interface Started {
  session: number;
  command: string;
  cwd: string;
}

export interface Exit {
  code: number | null;
  /** The end of what the agent wrote to standard error. */
  stderr: string;
}

export async function listAgents(): Promise<AgentList> {
  if (!inTauri) return { agents: [], defaultWorkspace: "" };
  return invoke<AgentList>("acp_agents");
}

/** Ask the user, natively, to allow a program for an agent. Resolves false when they decline. */
export async function chooseCommand(agent: AgentId, program: string, args: string[]): Promise<boolean> {
  return invoke<boolean>("acp_choose_command", { agent, program, args });
}

export async function clearCommand(agent: AgentId): Promise<void> {
  await invoke("acp_clear_command", { agent });
}

// The Anthropic API key for Claude Agent
//
// Kept in the operating system's credential store by Rust, which hands it to the
// Claude agent's process when that starts. The web view can save it, remove it
// and ask whether one is saved; there is deliberately no way to read it back.

/** Whether an Anthropic API key is saved. Never the key itself. */
export async function anthropicKeySaved(): Promise<boolean> {
  if (!inTauri) return false;
  return invoke<boolean>("anthropic_key_saved");
}

export async function saveAnthropicKey(value: string): Promise<void> {
  await invoke("anthropic_key_set", { value });
}

export async function removeAnthropicKey(): Promise<void> {
  await invoke("anthropic_key_delete");
}

/** Split a typed argument line on spaces, keeping quoted parts together. */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (const match of line.matchAll(pattern)) {
    out.push(match[1] !== undefined ? match[1].replace(/\\(.)/g, "$1") : (match[2] ?? match[3]));
  }
  return out;
}

// Events

interface DataPayload {
  session: number;
  line?: string;
  tooLong?: boolean;
}

interface ExitPayload {
  session: number;
  code: number | null;
  stderr: string;
}

interface Sink {
  line: (line: string) => void;
  exit: (exit: Exit) => void;
}

/**
 * Lines and exits by session. A process can write, or end, before anything has
 * subscribed to it (a program that fails at once ends before `acp_start` has
 * even returned), so what arrives early is kept until someone asks.
 */
const sinks = new Map<number, Sink>();
const early = new Map<number, { lines: string[]; exit?: Exit }>();
let listening: Promise<void> | null = null;

function deliverLine(session: number, line: string) {
  const sink = sinks.get(session);
  if (sink) sink.line(line);
  else {
    const held = early.get(session) ?? { lines: [] };
    held.lines.push(line);
    early.set(session, held);
  }
}

function deliverExit(session: number, exit: Exit) {
  const sink = sinks.get(session);
  if (sink) sink.exit(exit);
  else {
    const held = early.get(session) ?? { lines: [] };
    held.exit = exit;
    early.set(session, held);
  }
}

function ensureListening(): Promise<void> {
  listening ??= Promise.all([
    listen<DataPayload>("studio://acp-data", ({ payload }) => {
      if (typeof payload.line === "string") deliverLine(payload.session, payload.line);
    }),
    listen<ExitPayload>("studio://acp-exit", ({ payload }) =>
      deliverExit(payload.session, { code: payload.code, stderr: payload.stderr ?? "" }),
    ),
  ]).then(() => undefined);
  return listening;
}

/** For tests: feed the event handlers directly. */
export const __events = { deliverLine, deliverExit, reset: () => (sinks.clear(), early.clear()) };

export interface AgentProcess {
  started: Started;
  /** The ACP message stream over the process's standard input and output. */
  stream: Stream;
  /** Resolves when the process ends, for whatever reason. */
  exited: Promise<Exit>;
  /** End the process and everything it started. */
  stop: () => Promise<void>;
  /** What the agent wrote to standard error lately. */
  stderr: () => Promise<string>;
}

/** Start an agent and connect to its standard input and output. */
export async function startAgent(agent: AgentId, cwd: string | null): Promise<AgentProcess> {
  if (!inTauri) throw new Error("The chat panel needs the desktop app.");
  await ensureListening();
  const started = await invoke<Started>("acp_start", { agent, cwd });
  return connectProcess(started, (line) => invoke("acp_send", { session: started.session, line }), {
    stop: () => invoke<boolean>("acp_stop", { session: started.session }).then(() => undefined),
    stderr: () => invoke<string | null>("acp_stderr", { session: started.session }).then((text) => text ?? ""),
  });
}

/**
 * The stream for a started session. Separate from `startAgent` so it can be
 * tested without Tauri: `send` writes one line, and lines come in through the
 * event handlers above.
 */
export function connectProcess(
  started: Started,
  send: (line: string) => Promise<unknown>,
  control: { stop: () => Promise<void>; stderr: () => Promise<string> },
): AgentProcess {
  const id = started.session;
  let resolveExit!: (exit: Exit) => void;
  const exited = new Promise<Exit>((done) => (resolveExit = done));
  let controller!: ReadableStreamDefaultController<AnyMessage>;
  let closed = false;

  const readable = new ReadableStream<AnyMessage>({
    start(c) {
      controller = c;
    },
  });

  const onLine = (line: string) => {
    if (closed) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // Not protocol: some agents print a stray log line to standard output.
      return;
    }
    if (message && typeof message === "object") controller.enqueue(message as AnyMessage);
  };
  const onExit = (exit: Exit) => {
    sinks.delete(id);
    if (!closed) {
      closed = true;
      controller.close();
    }
    resolveExit(exit);
  };

  sinks.set(id, { line: onLine, exit: onExit });
  const held = early.get(id);
  early.delete(id);
  for (const line of held?.lines ?? []) onLine(line);
  if (held?.exit) onExit(held.exit);

  const writable = new WritableStream<AnyMessage>({
    async write(message) {
      await send(JSON.stringify(message));
    },
  });

  return { started, stream: { readable, writable }, exited, stop: control.stop, stderr: control.stderr };
}
