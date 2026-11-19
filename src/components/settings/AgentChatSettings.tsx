import { useEffect, useState } from "react";
import { FolderOpen, RefreshCw } from "lucide-react";
import { useAgentChatSettings } from "../../hooks/useAgentChatSettings";
import type { AgentId, AgentInfo } from "../../lib/acpProcess";
import { AnthropicKeyField } from "../agent-chat/AnthropicKeyField";
import { testAgent } from "../../lib/agentChatTest";
import { INSTRUCTIONS_FILE, instructionsStatus, restoreInstructions, type InstructionsState } from "../../lib/agentProfile";
import { agentChatShortcutLabel, setAgentChatPanelOpen } from "../../lib/agentChatPanel";
import { isMac } from "../../lib/platform";
import { inTauri } from "../../lib/request";

/** An argument as it's typed back in: quoted when it holds a space or a quote. */
function quoteArg(arg: string): string {
  return /[\s"']/.test(arg) || arg === "" ? `"${arg.replace(/(["\\])/g, "\\$1")}"` : arg;
}

/** Whether the agent can start: a short word for the card's chip. */
function stateWord(agent: AgentInfo): { text: string; tone: "ok" | "warn" | "" } {
  if (agent.how === "missing") return { text: agent.id === "custom" ? "Not set up" : "Not found", tone: "" };
  if (agent.how === "npx") return { text: "Via npx", tone: "warn" };
  return { text: agent.how === "chosen" ? "Your program" : "Installed", tone: "ok" };
}

/** How a found agent is started, when it isn't simply installed. */
function howText(agent: AgentInfo): string {
  return agent.how === "npx"
    ? "Runs its adapter with npx. The first start downloads it, which needs Node.js and a moment."
    : "Uses the program you chose";
}

const INSTALL: Record<Exclude<AgentId, "custom">, string> = {
  claude:
    "Studio runs Claude through Anthropic's Claude Agent SDK, using its ACP adapter. It needs Node.js and an Anthropic API key.",
  codex: "Install Codex (`npm install -g @openai/codex`) and sign in with `codex login`. Studio runs it through its ACP adapter.",
  gemini: "Install Gemini CLI (`npm install -g @google/gemini-cli`) and sign in with `gemini`.",
};

/** The Anthropic API key Claude Agent uses. */
function AnthropicKey() {
  return (
    <section>
      <div className="section-head">
        <h2 className="h2">Anthropic API key</h2>
      </div>
      <p className="field-meta">
        Claude Agent signs in with an Anthropic API key. Studio keeps it in your system&apos;s credential store and gives
        it only to the Claude agent when a chat starts. Without one, Studio uses an{" "}
        <span className="mono">ANTHROPIC_API_KEY</span> it was started with, if any. With neither, Claude Agent
        doesn&apos;t start: Studio never lets it use a claude.ai sign-in.
      </p>
      <AnthropicKeyField />
    </section>
  );
}

/**
 * Settings for the chat panel: which agent it talks to, where that agent
 * works, and a connection test. Off until an agent is chosen.
 */
export function AgentChatSettings() {
  const settings = useAgentChatSettings();
  const { prefs, agents, findAgents } = settings;
  const [editing, setEditing] = useState<AgentId | null>(null);
  const [program, setProgram] = useState("");
  const [args, setArgs] = useState("");
  const [test, setTest] = useState<{ running: boolean; text: string; ok: boolean } | null>(null);

  useEffect(() => {
    if (inTauri && agents === null) void findAgents();
  }, [agents, findAgents]);

  const startEditing = (agent: AgentInfo) => {
    setEditing(agent.id);
    setProgram(agent.chosen?.program ?? "");
    setArgs(agent.chosen?.args.map(quoteArg).join(" ") ?? "");
  };

  const runTest = async () => {
    if (!prefs.agent) return;
    setTest({ running: true, text: "Starting the agent…", ok: true });
    const result = await testAgent(prefs.agent, prefs.workspace);
    setTest({ running: false, text: result.text, ok: result.ok });
  };

  const chooseFolder = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true, multiple: false, title: "Folder the agent works in" });
    if (typeof picked === "string") await settings.setPrefs({ workspace: picked });
  };

  if (!inTauri) return <p className="settings-lead">The chat panel needs the desktop app.</p>;

  return (
    <>
      <p className="settings-lead">
        The chat opens in a panel on the right ({agentChatShortcutLabel(isMac)}). Studio starts the agent on this
        computer, signed in with your own account, and points it at Studio&apos;s MCP server when that&apos;s running.
        Studio doesn&apos;t run a model of its own and never sees your sign-in.
      </p>
      <p className="field-meta">
        What you type, and anything you attach, goes to the agent you choose and from there to its model provider.
        Secret values from your environments are replaced by their <span className="mono">{"{{name}}"}</span> before
        anything is sent. Past chats are kept on this computer only.
      </p>

      <section className="agent-section">
        <div className="section-head">
          <h2 className="h2">Agent</h2>
        </div>
        <div className="agent-choices" role="radiogroup" aria-label="Agent">
          <label className={`agent-choice agent-choice-none${prefs.agent === null ? " on" : ""}`}>
            <input
              type="radio"
              name="agent"
              checked={prefs.agent === null}
              onChange={() => void settings.setPrefs({ agent: null })}
            />
            <span>
              <strong>None</strong>
              <span className="field-meta">The chat panel is off.</span>
            </span>
          </label>
          {(agents ?? []).map((agent) => (
            <div key={agent.id} className={`agent-choice-wrap${prefs.agent === agent.id ? " on" : ""}`}>
              <label className={`agent-choice${agent.how === "missing" ? " missing" : ""}`}>
                <input
                  type="radio"
                  name="agent"
                  checked={prefs.agent === agent.id}
                  disabled={agent.how === "missing"}
                  onChange={() => void settings.setPrefs({ agent: agent.id })}
                />
                <span>
                  <span className="agent-choice-title">
                    <strong>{agent.name}</strong>
                    <span className={`chip sans ${stateWord(agent).tone}`}>{stateWord(agent).text}</span>
                  </span>
                  {(agent.how === "npx" || agent.how === "chosen") && <span className="field-meta">{howText(agent)}</span>}
                  {agent.command && <code className="agent-command mono">{agent.command}</code>}
                  {agent.id !== "custom" && agent.how === "missing" && (
                    <span className="field-meta">{INSTALL[agent.id]}</span>
                  )}
                  {agent.id !== "custom" && agent.id !== "claude" && agent.how !== "missing" && !agent.cliFound && (
                    <span className="field-meta warn">
                      <span className="mono">{agent.cli}</span> wasn&apos;t found. You need to have signed in with it
                      once for a chat to work.
                    </span>
                  )}
                  {agent.id === "custom" && agent.how === "missing" && (
                    <span className="field-meta">Any program that speaks the Agent Client Protocol.</span>
                  )}
                </span>
              </label>
              <div className="agent-choice-actions">
                {prefs.agent === agent.id && (
                  <button className="btn" onClick={() => void runTest()} disabled={test?.running}>
                    Test connection
                  </button>
                )}
                {editing !== agent.id && (
                  <button className="btn ghost" onClick={() => startEditing(agent)}>
                    {agent.id === "custom" ? "Set the command…" : "Choose the program…"}
                  </button>
                )}
                {agent.how === "chosen" && (
                  <button className="btn ghost" onClick={() => void settings.forget(agent.id)}>
                    Forget
                  </button>
                )}
              </div>
              {editing === agent.id && (
                <div className="agent-edit">
                  <div className="field">
                    <div className="field-label">
                      <div className="field-label-text">Program</div>
                      <div className="field-meta">full path</div>
                    </div>
                    <input
                      value={program}
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      placeholder={isMac ? "/opt/homebrew/bin/claude-agent-acp" : "/usr/local/bin/my-agent"}
                      onChange={(event) => setProgram(event.target.value)}
                    />
                  </div>
                  <div className="field">
                    <div className="field-label">
                      <div className="field-label-text">Arguments</div>
                    </div>
                    <input
                      value={args}
                      placeholder="--acp"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      onChange={(event) => setArgs(event.target.value)}
                    />
                  </div>
                  <div className="settings-actions">
                    <button
                      className="btn primary"
                      disabled={!program.trim()}
                      onClick={async () => {
                        if (await settings.choose(agent.id, program, args)) setEditing(null);
                      }}
                    >
                      Save
                    </button>
                    <button className="btn" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                    <span className="field-meta">Studio asks you to confirm the exact command before saving it.</span>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
        {settings.error && <div className="error-box">{settings.error}</div>}
        <div className="settings-actions">
          <button className="btn" onClick={() => void findAgents()} disabled={settings.searching}>
            <RefreshCw size={13} className={settings.searching ? "spin" : undefined} /> Look again
          </button>
          <button
            className="btn primary"
            disabled={!prefs.agent}
            onClick={() => setAgentChatPanelOpen(true)}
            title={agentChatShortcutLabel(isMac)}
          >
            Open the chat panel
          </button>
        </div>
        {test && (
          <div className={test.ok ? "agent-test" : "error-box agent-test-fail"} role="status">
            {test.text}
          </div>
        )}
      </section>

      {prefs.agent === "claude" && <AnthropicKey />}
      <div className="section-head">
        <h2 className="h2">What the agent gets</h2>
      </div>
      <div className="rows">
        <div className="row-s">
          <div className="l">
            <b>Studio&apos;s tools</b>
            <span className="meta">
              When a chat starts, Studio starts its local MCP server if it isn&apos;t running and connects the agent to
              it, so the agent can look up your APIs, send requests, start local mocks and run collections. Requests
              and other actions still ask you first. The first message also tells the agent what you have open.
            </span>
          </div>
          <div className="c">
            <input
              type="checkbox"
              className="switch"
              role="switch"
              aria-label="Give the agent Studio's tools"
              checked={prefs.studioTools}
              onChange={(event) => void settings.setPrefs({ studioTools: event.target.checked })}
            />
          </div>
        </div>
        <div className="row-s">
          <div className="l">
            <b>Studio&apos;s instructions</b>
            <span className="meta">
              How to work in Studio: start from the spec, try changes against a local mock, build tests as collections,
              never ask for secret values. In Studio&apos;s own folder they go in{" "}
              <span className="mono">{prefs.agent ? INSTRUCTIONS_FILE[prefs.agent] : "AGENTS.md"}</span>; in a folder
              you chose, Studio writes nothing and sends them with the first message. The text is in Studio&apos;s
              repository, under <span className="mono">src/agent-profile</span>.
            </span>
            {prefs.agent && prefs.instructions && !prefs.workspace && <InstructionsStatus agent={prefs.agent} />}
          </div>
          <div className="c">
            <input
              type="checkbox"
              className="switch"
              role="switch"
              aria-label="Use Spec0 instructions"
              checked={prefs.instructions}
              onChange={(event) => void settings.setPrefs({ instructions: event.target.checked })}
            />
          </div>
        </div>
        <div className="row-s">
          <div className="l">
            <b>Folder</b>
            <span className="meta mono agent-folder" title={prefs.workspace ?? settings.defaultWorkspace}>
              {prefs.workspace ?? `${settings.defaultWorkspace || "Studio's own folder"} (default)`}
            </span>
            <span className="meta">
              The agent works here and can ask to read or change files in it. Studio&apos;s own folder is empty; choose a
              project folder to have it work on your specs.
            </span>
          </div>
          <div className="c">
            {prefs.workspace && (
              <button className="btn ghost" onClick={() => void settings.setPrefs({ workspace: null })}>
                Use Studio&apos;s folder
              </button>
            )}
            <button className="btn" onClick={() => void chooseFolder()}>
              <FolderOpen size={13} /> Choose…
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

/** Whether the user has edited Studio's instructions file, with a way to put Studio's version back. */
function InstructionsStatus({ agent }: { agent: AgentId }) {
  const [state, setState] = useState<InstructionsState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    instructionsStatus(agent)
      .then((next) => live && setState(next))
      .catch(() => live && setState(null));
    return () => {
      live = false;
    };
  }, [agent]);

  if (state !== "edited") return null;
  const restore = async () => {
    try {
      setState(await restoreInstructions(agent));
    } catch (failed) {
      setError(failed instanceof Error ? failed.message : String(failed));
    }
  };
  return (
    <div className="settings-actions" role="status">
      <span className="field-meta warn">
        You&apos;ve edited {INSTRUCTIONS_FILE[agent]} or one of the guides, so Studio leaves them as they are.
      </span>
      <button className="btn" onClick={() => void restore()}>
        Restore Studio&apos;s version
      </button>
      {error && <span className="field-meta warn">{error}</span>}
    </div>
  );
}
