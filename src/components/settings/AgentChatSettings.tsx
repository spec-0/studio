import { useEffect, useState } from "react";
import { FolderOpen, RefreshCw } from "lucide-react";
import { useAgentChatSettings } from "../../hooks/useAgentChatSettings";
import {
  anthropicKeySaved,
  removeAnthropicKey,
  saveAnthropicKey,
  type AgentId,
  type AgentInfo,
} from "../../lib/acpProcess";
import { testAgent } from "../../lib/agentChatTest";
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
  codex: "Install Codex and sign in with `codex login`. Studio runs it through its ACP adapter.",
  gemini: "Install Gemini CLI (`npm install -g @google/gemini-cli`) and sign in with `gemini`.",
};

/** A message from a failed keychain call, which never contains the key. */
function keyError(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return String(error);
}

/**
 * The Anthropic API key Claude Agent uses. Saved to the operating system's
 * credential store; once saved, this only ever knows that there is one.
 */
function AnthropicKey() {
  const [saved, setSaved] = useState<boolean | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    anthropicKeySaved()
      .then(setSaved)
      .catch((err) => setError(`Couldn't read the credential store: ${keyError(err)}`));
  }, []);

  const run = async (work: () => Promise<void>, after: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      setSaved(after);
      setValue("");
    } catch (err) {
      setError(keyError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="section">
      <h3>Anthropic API key</h3>
      <p className="field-meta">
        Claude Agent signs in with an Anthropic API key. Studio keeps it in your system&apos;s credential store and gives
        it only to the Claude agent when a chat starts. Without one, Studio uses an{" "}
        <span className="mono">ANTHROPIC_API_KEY</span> it was started with, if any. With neither, Claude Agent
        doesn&apos;t start: Studio never lets it use a claude.ai sign-in.
      </p>
      <dl className="settings-facts">
        <dt>Key</dt>
        <dd>{saved === null ? "…" : saved ? "Saved" : "Not saved"}</dd>
      </dl>
      <div className="settings-actions">
        <input
          type="password"
          value={value}
          aria-label="Anthropic API key"
          placeholder={saved ? "Paste a new key to replace it" : "sk-ant-…"}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => setValue(event.target.value)}
        />
        <button
          className="btn primary"
          disabled={busy || !value.trim()}
          onClick={() => void run(() => saveAnthropicKey(value), true)}
        >
          Save
        </button>
        {saved && (
          <button className="btn ghost" disabled={busy} onClick={() => void run(removeAnthropicKey, false)}>
            Remove
          </button>
        )}
      </div>
      {error && <div className="error-box">{error}</div>}
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
                  {agent.id !== "custom" && agent.how !== "missing" && !agent.cliFound && (
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
                      <div className="field-name">program</div>
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
                      <div className="field-name">arguments</div>
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
