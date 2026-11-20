# Agent chat: how it's built

Notes for working on the Agent panel. What it does for users is in the
[user guide](https://studio-docs.spec0.io/agent-chat/).

## The pieces

- **The way in** is the **Agent** button at the right of the top bar
  (`TitleBar.tsx`), and `⇧⌘J` / `Ctrl+Shift+J`. Whether the panel is open, and
  what the chat is doing (`idle`, `running`, or `waiting` while a permission
  question is open, from `chatActivityOf`), live outside React in
  `src/lib/agentChatPanel.ts`, so the button can show a dot while the panel is
  closed. The panel publishes the activity; the button only reads it.
- **Set up your agent** (`src/components/agent-chat/AgentSetup.tsx`) shows in
  the panel until an agent is chosen and has connected. What it lists, and what
  each agent needs, comes from `src/lib/agentSetup.ts`: `setupRows` sorts the
  agents into found and not found and gives each a state (`ready`, `needs-cli`,
  `needs-key` for Claude without a key, `missing`); `initialStep` and
  `stepAfterTest` give the view's step. Picking an agent saves it to the same
  prefs Settings uses and runs the same connection test (`agentChatTest.ts`).
  The install and sign-in commands it shows are the ones each project
  documents; keep them in step with Settings → Agent chat. The Anthropic key
  field is shared with Settings (`AnthropicKeyField.tsx`).

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
  (pinned): `initialize`, `session/new` with Studio's MCP server when the chat
  has one, `session/prompt`, `session/cancel`, and answers to
  `session/request_permission`. Studio declines the file system and terminal
  client capabilities, so agents use their own tools and ask before they do.
  `applyUpdate` folds `session/update` notifications into the conversation.
- **`src/lib/zodJitless.ts`** switches zod to jitless mode before the ACP library
  loads. Without it zod compiles its checks with `new Function`, which the app's
  content security policy blocks. `npm run test:csp` runs a chat under the real
  policy to catch this.
- **`src/lib/agentChat.ts`** has the settings, the `@` attachments (always
  redacted), what a message is sent as, and the kept conversations. It also
  writes the note about Studio that the first message of each session carries
  (`studioContextNote`, sent as a `studio://context` resource, or as text when
  the agent doesn't take resources), the suggestions an empty chat shows, and
  `studioLinkFor`, which reads a finished `create_collection` or
  `run_collection` card's output for its **Open in Studio** button. Agents name
  MCP tools differently in their cards (`mcp__spec0-studio__create_collection`,
  `spec0-studio/run_collection`), so it matches the tool name anywhere in the
  title or input.
- **Studio's tools.** With **Give the agent Studio's tools** on (the default),
  `connect` in `useAgentChat` calls `ensureMcpRunning` in
  `src/lib/mcpServer.ts`, which starts the local MCP server with the saved port
  and token when it isn't running. `startMcp` and `stopMcp` announce every start
  and stop with `MCP_STATE_EVENT`; a session that was given the server treats
  any of them as losing it (a stop, a restart or a new token all end the agent's
  MCP session) and the panel offers **Reconnect**. The Claude and Codex adapters
  both accept HTTP MCP servers and embedded resources.
- **Studio's instructions.** The text is in `src/agent-profile/`
  (`instructions.md` and `guides/*.md`). Rust bundles it with `include_str!` in
  `src-tauri/src/agent_profile.rs`, and `acp_start` writes it into Studio's own
  agent folder before the agent starts, as the file that agent reads:
  - Codex reads `AGENTS.md` from its working folder. Without a git repository
    around it, it checks only that folder. The Codex adapter starts Codex with
    the session's folder.
  - The Claude adapter starts Claude with `settingSources` `user`, `project` and
    `local`, so `CLAUDE.md` in the working folder is read.
  - Gemini CLI reads `GEMINI.md` from its workspace folders and their parents.
  - Other ACP programs get `AGENTS.md`, the shared convention.

  Writes go only to fixed names inside that folder (`agent_profile::inside`
  refuses anything else). Studio records what it last wrote in
  `instructions.json` in its settings folder: a file still exactly as written is
  rewritten when the bundled text changes, and a file that differs is the
  user's and is left alone until **Restore Studio's version**. Turning the
  setting off removes Studio's unchanged files. When the agent works in a folder
  the user chose, or writing failed, `acp_start` reports it (`elsewhere`,
  `failed`) and `firstMessageNote` in `src/lib/agentProfile.ts` sends the
  instructions and guides with the first message. Bump
  `agent_profile::VERSION` when the text changes.
- **`src/lib/markdown.ts`** reads agent messages into plain data that the panel
  renders as React elements, never HTML. Only `http(s)` links are links, and
  images are shown as their description.
- **`src/hooks/useAgentChat.ts`** and **`src/components/agent-chat/`** are the
  panel; **`src/components/settings/AgentChatSettings.tsx`** is Settings → Agent
  chat. The panel is docked: `App.tsx` puts the page (`.app-main`) and the panel
  side by side in `.app-body`, so the page shrinks instead of sitting under it.
  Its width is clamped by `clampChatWidth` in `src/lib/agentChatPanel.ts`, which
  always leaves the page 580 px, and is kept in local storage per viewer. The
  console, which spans the page, reads `--agent-chat-space` to stop where the
  panel starts.

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
