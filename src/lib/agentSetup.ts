import type { AgentId, AgentInfo } from "./acpProcess";

/**
 * The "Set up your agent" view in the chat panel: which agents are on this
 * computer, what each needs before a chat can start, and where setup is.
 *
 * Kept free of React so every state can be tested. Settings → Agent chat
 * stays the full place for options; both read and write the same prefs.
 */

/** The agent chat guide. */
export const AGENT_CHAT_DOCS_URL = "https://studio-docs.spec0.io/agent-chat/";

/** The agents the setup view offers. A custom ACP program is set up in Settings. */
export type SetupAgentId = Exclude<AgentId, "custom">;

/**
 * Where an agent stands:
 * - `missing`: not on this computer; `install` says what to get.
 * - `needs-cli`: Studio can start it, but the agent's own command line, which
 *   it signs in with, wasn't found.
 * - `needs-key`: Claude Agent without an Anthropic API key.
 * - `ready`: nothing known to be missing. Whether it's signed in only shows
 *   when the connection is tested.
 */
export type SetupState = "missing" | "needs-cli" | "needs-key" | "ready";

export interface SetupRow {
  id: SetupAgentId;
  name: string;
  state: SetupState;
  /** How this agent signs in, in one or two sentences. */
  signIn: string;
  /** What to install, with a command to copy when there is one. */
  install: { text: string; command: string | null } | null;
}

/** How each agent signs in. Commands are the ones each project documents. */
const SIGN_IN: Record<SetupAgentId, string> = {
  codex:
    "Signs in with your ChatGPT account: run `codex login` once in a terminal. An OpenAI API key works too, with `codex login --with-api-key`.",
  claude: "Uses an Anthropic API key, which Studio keeps in your system's credential store. Studio doesn't use a claude.ai sign-in.",
  gemini: "Signs in with your Google account: run `gemini` once in a terminal and choose Sign in with Google.",
};

const NODE = "It runs through an adapter that needs Node.js, from nodejs.org.";

/** What to install when an agent, or the command line it signs in with, isn't found. */
const INSTALL: Record<SetupAgentId, { missing: { text: string; command: string | null }; cli: { text: string; command: string | null } | null }> = {
  codex: {
    missing: { text: `${NODE} Then install Codex:`, command: "npm install -g @openai/codex" },
    cli: { text: "Install Codex to sign in to it:", command: "npm install -g @openai/codex" },
  },
  claude: {
    missing: { text: NODE, command: null },
    cli: null,
  },
  gemini: {
    missing: { text: "Install Gemini CLI (or `brew install gemini-cli`):", command: "npm install -g @google/gemini-cli" },
    cli: null,
  },
};

const ORDER: SetupAgentId[] = ["codex", "claude", "gemini"];

function isSetupAgent(id: AgentId): id is SetupAgentId {
  return id !== "custom";
}

/** One agent's row in the setup view. `keySaved`: an Anthropic API key is saved. */
export function setupRow(agent: AgentInfo & { id: SetupAgentId }, keySaved: boolean): SetupRow {
  const base = { id: agent.id, name: agent.name, signIn: SIGN_IN[agent.id] };
  if (agent.how === "missing") return { ...base, state: "missing", install: INSTALL[agent.id].missing };
  if (agent.id === "claude") return { ...base, state: keySaved ? "ready" : "needs-key", install: null };
  const cli = INSTALL[agent.id].cli;
  if (!agent.cliFound && cli) return { ...base, state: "needs-cli", install: cli };
  return { ...base, state: "ready", install: null };
}

/** The agents found on this computer, then the ones that weren't, in a fixed order. */
export function setupRows(agents: AgentInfo[], keySaved: boolean): { found: SetupRow[]; missing: SetupRow[] } {
  const rows = agents
    .filter((agent): agent is AgentInfo & { id: SetupAgentId } => isSetupAgent(agent.id))
    .sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id))
    .map((agent) => setupRow(agent, keySaved));
  return { found: rows.filter((row) => row.state !== "missing"), missing: rows.filter((row) => row.state === "missing") };
}

/**
 * The step the setup view is on:
 * - `searching`: looking for agents.
 * - `none-found`: no agent on this computer.
 * - `choose`: pick one of the agents found.
 * - `testing`: starting the chosen agent to check it connects.
 * - `failed`: it didn't, with what to do next.
 * - `ready`: it connected; the chat can start.
 */
export type SetupStep =
  | { kind: "searching" }
  | { kind: "none-found" }
  | { kind: "choose" }
  | { kind: "testing"; agent: SetupAgentId }
  | { kind: "failed"; agent: SetupAgentId; text: string }
  | { kind: "ready"; agent: SetupAgentId; text: string };

/** The step before any test has run, from what discovery found. */
export function initialStep(agents: AgentInfo[] | null, searching: boolean): SetupStep {
  if (agents === null || (searching && agents.length === 0)) return { kind: "searching" };
  return setupRows(agents, false).found.length === 0 ? { kind: "none-found" } : { kind: "choose" };
}

/** The step after a connection test. */
export function stepAfterTest(agent: SetupAgentId, result: { ok: boolean; text: string }): SetupStep {
  return result.ok ? { kind: "ready", agent, text: result.text } : { kind: "failed", agent, text: result.text };
}

/** Text with `code` spans, split so a view can show them in a mono font. */
export function codeSpans(text: string): { text: string; code: boolean }[] {
  return text
    .split(/(`[^`]+`)/)
    .filter(Boolean)
    .map((part) => (part.startsWith("`") && part.endsWith("`") ? { text: part.slice(1, -1), code: true } : { text: part, code: false }));
}
