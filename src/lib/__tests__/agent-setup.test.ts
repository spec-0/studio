import { describe, expect, it } from "vitest";
import type { AgentInfo } from "../acpProcess";
import type { ChatItem } from "../acpClient";
import {
  AGENT_CHAT_DOCS_URL,
  codeSpans,
  initialStep,
  setupRows,
  stepAfterTest,
} from "../agentSetup";
import {
  agentButtonText,
  agentChatActivity,
  chatActivityOf,
  setAgentChatActivity,
  subscribeAgentChatActivity,
} from "../agentChatPanel";

function agent(id: AgentInfo["id"], how: AgentInfo["how"], cliFound = true): AgentInfo {
  const names = { claude: "Claude Agent", codex: "Codex", gemini: "Gemini CLI", custom: "Another agent" } as const;
  return { id, name: names[id], how, command: how === "missing" ? "" : id, chosen: null, cliFound, cli: id };
}

describe("agent setup: what each agent needs", () => {
  it("is still searching until discovery has answered", () => {
    expect(initialStep(null, true)).toEqual({ kind: "searching" });
    expect(initialStep(null, false)).toEqual({ kind: "searching" });
  });

  it("says nothing was found, and lists what to install with commands to copy", () => {
    const agents = [agent("claude", "missing"), agent("codex", "missing"), agent("gemini", "missing"), agent("custom", "missing")];
    expect(initialStep(agents, false)).toEqual({ kind: "none-found" });
    const { found, missing } = setupRows(agents, false);
    expect(found).toEqual([]);
    expect(missing.map((row) => row.id)).toEqual(["codex", "claude", "gemini"]);
    expect(missing.find((row) => row.id === "codex")?.install?.command).toBe("npm install -g @openai/codex");
    expect(missing.find((row) => row.id === "gemini")?.install?.command).toBe("npm install -g @google/gemini-cli");
    // Claude Agent needs Node.js, which has no single install command.
    expect(missing.find((row) => row.id === "claude")?.install).toEqual({ text: expect.stringContaining("Node.js"), command: null });
  });

  it("leaves a custom ACP program to Settings", () => {
    const { found, missing } = setupRows([agent("custom", "chosen")], false);
    expect([...found, ...missing]).toEqual([]);
  });

  it("offers agents that were found, in a fixed order", () => {
    const agents = [agent("gemini", "installed"), agent("codex", "npx"), agent("claude", "npx")];
    expect(initialStep(agents, false)).toEqual({ kind: "choose" });
    expect(setupRows(agents, true).found.map((row) => row.id)).toEqual(["codex", "claude", "gemini"]);
  });

  it("asks for the agent's own command line when Codex can start but can't be signed in to", () => {
    const [row] = setupRows([agent("codex", "npx", false)], false).found;
    expect(row.state).toBe("needs-cli");
    expect(row.install?.command).toBe("npm install -g @openai/codex");
    expect(row.signIn).toContain("`codex login`");
  });

  it("is ready when Codex and its command line are both there", () => {
    const [row] = setupRows([agent("codex", "installed", true)], false).found;
    expect(row).toMatchObject({ state: "ready", install: null });
  });

  it("asks for an Anthropic API key for Claude Agent until one is saved, whatever the claude CLI", () => {
    expect(setupRows([agent("claude", "npx", false)], false).found[0].state).toBe("needs-key");
    expect(setupRows([agent("claude", "npx", false)], true).found[0].state).toBe("ready");
    expect(setupRows([agent("claude", "npx")], false).found[0].signIn).toContain("doesn't use a claude.ai sign-in");
  });

  it("moves to failed with the test's next step, or to ready", () => {
    const failed = stepAfterTest("codex", { ok: false, text: "The agent needs you to sign in to it first, in a terminal." });
    expect(failed).toEqual({ kind: "failed", agent: "codex", text: "The agent needs you to sign in to it first, in a terminal." });
    expect(stepAfterTest("codex", { ok: true, text: "Connected to Codex 2.2.2." })).toEqual({
      kind: "ready",
      agent: "codex",
      text: "Connected to Codex 2.2.2.",
    });
  });

  it("splits `code` out of setup text", () => {
    expect(codeSpans("Run `codex login` once.")).toEqual([
      { text: "Run ", code: false },
      { text: "codex login", code: true },
      { text: " once.", code: false },
    ]);
  });

  it("links to the agent chat guide", () => {
    expect(AGENT_CHAT_DOCS_URL).toBe("https://studio-docs.spec0.io/agent-chat/");
  });
});

describe("the top bar's Agent button", () => {
  const permission = (state: "pending" | "answered"): ChatItem => ({ kind: "permission", id: "p", title: "Run?", options: [], state });

  it("shows waiting while a permission question is open, running while a session is live", () => {
    expect(chatActivityOf(false, [])).toBe("idle");
    expect(chatActivityOf(true, [])).toBe("running");
    expect(chatActivityOf(true, [permission("answered")])).toBe("running");
    expect(chatActivityOf(true, [permission("pending")])).toBe("waiting");
  });

  it("tells listeners when the activity changes, and only then", () => {
    let calls = 0;
    const stop = subscribeAgentChatActivity(() => calls++);
    setAgentChatActivity("running");
    setAgentChatActivity("running");
    setAgentChatActivity("waiting");
    stop();
    setAgentChatActivity("idle");
    expect(calls).toBe(2);
    expect(agentChatActivity()).toBe("idle");
  });

  it("labels itself for screen readers and shows the shortcut", () => {
    expect(agentButtonText(false, "idle", true)).toEqual({ label: "Agent", title: "Open the agent chat (⇧⌘J)" });
    expect(agentButtonText(true, "running", false)).toEqual({
      label: "Agent. The agent is running",
      title: "Close the agent chat (Ctrl+Shift+J). The agent is running.",
    });
    expect(agentButtonText(false, "waiting", true).label).toBe("Agent. The agent is waiting for your answer");
  });
});
