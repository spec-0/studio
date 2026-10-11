import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../request", () => ({ inTauri: true }));

const acp = await import("../acpProcess");
const { SIGN_IN } = await import("../../hooks/useAgentChat");

describe("the Anthropic API key for Claude Agent", () => {
  beforeEach(() => invoke.mockReset());

  it("is saved and removed through Rust, and the web view only learns whether one is saved", async () => {
    invoke.mockResolvedValue(true);
    expect(await acp.anthropicKeySaved()).toBe(true);
    expect(invoke).toHaveBeenLastCalledWith("anthropic_key_saved");

    invoke.mockResolvedValue(undefined);
    await acp.saveAnthropicKey("sk-ant-test");
    expect(invoke).toHaveBeenLastCalledWith("anthropic_key_set", { value: "sk-ant-test" });
    await acp.removeAnthropicKey();
    expect(invoke).toHaveBeenLastCalledWith("anthropic_key_delete");
  });

  it("can't be read back by the web view", () => {
    const readers = Object.keys(acp).filter((name) => /key/i.test(name) && !/saved|save|remove/i.test(name));
    expect(readers).toEqual([]);
  });

  it("isn't part of starting an agent: the web view names the agent and Rust adds the key for Claude", async () => {
    invoke.mockResolvedValue({ session: 1, command: "claude-agent-acp", cwd: "/tmp" });
    await acp.startAgent("claude", null);
    const start = invoke.mock.calls.find(([command]) => command === "acp_start");
    expect(start?.[1]).toEqual({ agent: "claude", cwd: null });
  });

  it("is what the sign-in hint for Claude points to", () => {
    expect(SIGN_IN.claude).toContain("Settings");
    expect(SIGN_IN.claude).toContain("Agent chat");
    expect(SIGN_IN.codex).not.toContain("API key");
  });
});
