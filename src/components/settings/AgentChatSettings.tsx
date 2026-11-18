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

function howText(agent: AgentInfo): string {
  switch (agent.how) {
    case "installed":
      return "Installed";
    case "npx":
      return "Runs its adapter with npx. The first start downloads it, which needs Node.js and a moment.";
    case "chosen":
      return "Uses the program you chose";
    default:
      return agent.id === "custom" ? "Not set up" : "Not found on this computer";
  }
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
    <section className="section">
      <h3>Anthropic API key</h3>
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

      <section className="section">
        <h3>Agent</h3>
        <div className="agent-choices" role="radiogroup" aria-label="Agent">
          <label className="agent-choice">
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
            <div key={agent.id} className="agent-choice-wrap">
              <label className={`agent-choice${agent.how === "missing" ? " missing" : ""}`}>
                <input
                  type="radio"
                  name="agent"
                  checked={prefs.agent === agent.id}
                  disabled={agent.how === "missing"}
                  onChange={() => void settings.setPrefs({ agent: agent.id })}
                />
                <span>
                  <strong>{agent.name}</strong>
                  <span className="field-meta">{howText(agent)}</span>
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
          <button className="btn" onClick={() => void runTest()} disabled={!prefs.agent || test?.running}>
            Test the connection
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

      <section className="section">
        <h3>Studio&apos;s tools</h3>
        <label className="check">
          <input
            type="checkbox"
            className="switch"
            role="switch"
            checked={prefs.studioTools}
            onChange={(event) => void settings.setPrefs({ studioTools: event.target.checked })}
          />
          Give the agent Studio&apos;s tools
        </label>
        <p className="field-meta">
          When a chat starts, Studio starts its local MCP server if it isn&apos;t running and connects the agent to
          it, so the agent can look up your APIs, send requests, start local mocks and run collections. Requests and
          other actions still ask you first, as they do for any agent. The first message of each chat also tells the
          agent it&apos;s in Studio and what you have open.
        </p>
      </section>

      <section className="section">
        <h3>Studio&apos;s instructions</h3>
        <label className="check">
          <input
            type="checkbox"
            className="switch"
            role="switch"
            checked={prefs.instructions}
            onChange={(event) => void settings.setPrefs({ instructions: event.target.checked })}
          />
          Use Spec0 instructions
        </label>
        <p className="field-meta">
          Tells the agent how to work in Studio: start from the spec, try changes against a local mock, build tests as
          collections, and never ask for secret values. A few step-by-step guides come with it. In Studio&apos;s own
          folder they go in the file the agent reads ({prefs.agent ? INSTRUCTIONS_FILE[prefs.agent] : "AGENTS.md"});
          in a folder you chose, Studio writes nothing and sends them with the first message instead. The text is in
          Studio&apos;s repository, under <span className="mono">src/agent-profile</span>.
        </p>
        {prefs.agent && prefs.instructions && !prefs.workspace && <InstructionsStatus agent={prefs.agent} />}
      </section>

      {prefs.agent === "claude" && <AnthropicKey />}

      <section className="section">
        <h3>Folder</h3>
        <p className="field-meta">
          The agent works in this folder and can ask to read or change files in it. By default it&apos;s an empty
          folder of Studio&apos;s own. Choose a project folder if you want the agent to work on your specs.
        </p>
        <dl className="settings-facts">
          <dt>Folder</dt>
          <dd className="mono">{prefs.workspace ?? `${settings.defaultWorkspace || "Studio's own folder"} (default)`}</dd>
        </dl>
        <div className="settings-actions">
          <button className="btn" onClick={() => void chooseFolder()}>
            <FolderOpen size={13} /> Choose a folder…
          </button>
          {prefs.workspace && (
            <button className="btn ghost" onClick={() => void settings.setPrefs({ workspace: null })}>
              Use Studio&apos;s empty folder
            </button>
          )}
        </div>
      </section>
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
