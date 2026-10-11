import type { Collection, StepTarget } from "./collection";
import type { StepResult } from "./collectionRun";
import type { ConnectionSettings } from "./connection";
import type { LibraryEntry } from "./library";
import type { RequestPlan } from "./request";
import type { RunLog } from "./runLog";
import type { Session } from "./spec0";

/**
 * What the agent tools need from the running app: the values on screen right
 * now (the active environment with its secret values, connection settings),
 * the collections as Studio holds them, and the actions that change them.
 *
 * Most MCP tools read what Studio stored, so they answer the same whichever
 * screen is open. These can't: a secret value is only in memory, and a
 * collection run has to go through the same hook that shows it in the Runs
 * view. `useAgentApp` registers the live version; until it has, the tools say
 * Studio isn't ready.
 */

export interface AgentRunOptions {
  /**
   * Send every step that uses a spec here instead of its own target.
   * `"first-server"` is each spec's first declared server.
   */
  target?: StepTarget | "first-server";
  /** Who started it, shown in the Runs view and the console. */
  startedBy: string;
  /** Asked before each request goes; a string is why it can't. */
  gate: (plan: RequestPlan) => Promise<string | null>;
  /** Checked before each step; true stops the run. */
  cancelled: () => boolean;
}

export type AgentRunOutcome = { runId: string; results: StepResult[] } | { error: string };

export interface AgentApp {
  entries(): LibraryEntry[];
  /** The active environment's values, secret ones included. Never returned to an agent. */
  vars(): Record<string, string>;
  environment(): { id: string; name: string } | null;
  connection(): ConnectionSettings;
  session(): Session | null;
  /** The OAuth token Studio holds for an API in the active environment, renewed if needed; "" when none. */
  oauthToken(entry: LibraryEntry): Promise<string>;
  /** History changed underneath the interface; read it again. */
  historyChanged(): void;
  localMocks: {
    /** Library id → port, for every local mock running now. */
    running(): Record<string, number>;
    start(entry: LibraryEntry): Promise<number>;
    stop(id: string): Promise<void>;
  };
  collections: {
    list(): Collection[];
    /** Add a collection without opening it, so the developer's screen doesn't jump. */
    add(collection: Collection): void;
    /** Change one collection; returns it as it is afterwards, or null when it's gone. */
    change(id: string, change: (collection: Collection) => Collection): Collection | null;
    run(id: string, options: AgentRunOptions): Promise<AgentRunOutcome>;
    /** A collection's run logs, newest first, the one in progress included. */
    runLogs(id: string): RunLog[];
    /** Write it to a file and keep it linked there. Returns what was left out of the file. */
    saveTo(id: string, path: string): Promise<string[]>;
  };
}

let current: AgentApp | null = null;

export function registerAgentApp(app: AgentApp | null): void {
  current = app;
}

export function agentApp(): AgentApp | null {
  return current;
}
