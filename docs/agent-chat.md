# Agent chat: how it's built

Notes for working on the Agent panel. What it does for users is in the
[README](../README.md#agent-chat).

## The pieces

- **`src-tauri/src/acp.rs`** starts and stops the agent process and passes its
  lines in both directions. The web view names an agent (`claude`, `codex`,
  `gemini` or `custom`); the program and its arguments are decided here. A
  program chosen by hand is saved only after a native confirmation that shows
  the exact command, in `agent/commands.json` under Studio's config folder, a
  place `store_write` can't reach. Each agent runs in its own process group (on
  Windows, `taskkill /T`), so stopping it stops what it started, and every agent
  is stopped when Studio quits.
- **The Anthropic API key** for Claude is stored by `src-tauri/src/secrets.rs`
  under one fixed account, `agent-chat:anthropic-api-key`. Environment secrets
  always have a `/` in their account and this has none, so no variable name can
  reach it, and it isn't in the secrets index. The web view has three commands:
  save, remove, and "is one saved?". Nothing returns the key. `acp_start` reads
  it only when the agent is Claude and sets `ANTHROPIC_API_KEY` on that one
  process (`agent_env`); if none is saved it passes on the one Studio was
  started with, if any. With neither, `agent_env` returns an error and the
  agent isn't started, so Claude Agent can't fall back to a claude.ai or Claude
  Code sign-in. For the same reason the Claude adapter always gets
  `--hide-claude-auth` (added in `resolve`, a chosen program included), and
  `CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR` are
  removed from its environment. The key is replaced with `[hidden]` in the
  agent's output lines, the error output kept for a session, and its exit
  message (`hide_secrets`). Codex, Gemini CLI and custom agents get nothing
  extra.
- **`src/lib/acpProcess.ts`** turns the line events into the message stream the
  ACP library reads and writes. Lines that arrive before anything listens are
  kept until something does.
- **`src/lib/acpClient.ts`** speaks the protocol with
  [`@agentclientprotocol/sdk`](https://www.npmjs.com/package/@agentclientprotocol/sdk)
  (pinned): `initialize`, `session/new` with Studio's MCP server when it's
  running, `session/prompt`, `session/cancel`, and answers to
  `session/request_permission`. Studio declines the file system and terminal
  client capabilities, so agents use their own tools and ask before they do.
  `applyUpdate` folds `session/update` notifications into the conversation.
- **`src/lib/zodJitless.ts`** switches zod to jitless mode before the ACP library
  loads. Without it zod compiles its checks with `new Function`, which the app's
  content security policy blocks. `npm run test:csp` runs a chat under the real
  policy to catch this.
- **`src/lib/agentChat.ts`** has the settings, the `@` attachments (always
  redacted), what a message is sent as, and the kept conversations.
- **`src/lib/markdown.ts`** reads agent messages into plain data that the panel
  renders as React elements, never HTML. Only `http(s)` links are links, and
  images are shown as their description.
- **`src/hooks/useAgentChat.ts`** and **`src/components/agent-chat/`** are the
  panel; **`src/components/settings/AgentChatSettings.tsx`** is Settings → Agent
  chat.

## Trying it without a real agent

`scripts/fake-acp-agent.mjs` is a stand-in agent with no model. It answers with
fixed text, shows a tool call and asks permission when a message says "tool",
calls Studio's MCP server when a message says "mcp", waits to be stopped when a
message says "slow", and lists what it received when a message says "attach".
The tests in `src/lib/__tests__/acp-client.test.ts` run it as a real process.

To use it in the app, choose **Another agent** in Settings → Agent chat, with
the full path to `node` as the program and the full path to the script as the
argument.

## Pinned versions

| Package | Version |
|---|---|
| `@agentclientprotocol/sdk` | 1.8.0 (ACP protocol version 1) |
| `@agentclientprotocol/claude-agent-acp` (through `npx`) | 0.89.1 |
| `@agentclientprotocol/codex-acp` (through `npx`) | 2.2.2 |

Gemini CLI is run as installed, with `--acp`. To move an adapter to a newer
version, change it in `src-tauri/src/acp.rs` and try a chat with that agent on
each platform first.
