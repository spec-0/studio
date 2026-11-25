# Architecture

A map of the code, for finding where a change goes. The reasons behind the rules it mentions are in
[docs/design-rules.md](docs/design-rules.md). File names here are checked by a test
(`src/lib/__tests__/architecture.test.ts`), so a new file in `src-tauri/src` or `src/lib` needs a
line below.

## The system

Studio is a Tauri v2 app: a Rust shell around a web view. Rust owns what a web view can't or
shouldn't do: sockets (local mocks, the MCP server, the OAuth callback), outbound HTTP, files,
the credential store, updates, and the agent process. The interface is React 19 and TypeScript,
and it holds the logic: parsing specs, building requests, checking responses, running collections,
and answering mock and MCP requests. Rust receives a socket's request, hands it to the web view as
an event, and sends back what the web view answers.

## Rust: `src-tauri/src`

| Module | What it owns |
|---|---|
| `main.rs` | The entry point; calls `lib.rs`. |
| `lib.rs` | Registers the plugins and every command, and starts the app. |
| `http.rs` | Outbound HTTP with reqwest, so requests carry no `Origin` and can use per-host certificate settings, a proxy and file bodies read from disk. |
| `cookies.rs` | One cookie jar per API for reqwest, in memory only. |
| `oauth.rs` | The loopback listener that receives an OAuth redirect, because a web view can't open a socket. |
| `storage.rs` | Reading and writing Studio's JSON files, and the narrow file commands (`write_collection`, `write_run_log`, `write_spec`). |
| `secrets.rs` | The OS credential store, under one fixed service name, with an index of names it wrote. |
| `updates.rs` | Checking for, downloading and installing updates, through the proxy from Network settings. |
| `menu.rs` | The app menu, including ⌘W for closing a request tab on macOS. |
| `mcp.rs` | The local MCP server's socket, its token, host and origin checks, and the protocol framing. |
| `local_mock.rs` | Each local mock's socket, its host and origin checks, CORS preflights, and response framing. |
| `deep_link.rs` | Receiving `spec0://` links from the OS and queuing them for the web view. |
| `git.rs` | A spec file's branch, commit and whether it has uncommitted changes, without running `/usr/bin/git`. |
| `acp.rs` | Starting and stopping the agent chat's agent process, passing its lines both ways, and its environment (the Anthropic key). |
| `agent_profile.rs` | Writing Studio's instructions for that agent into its folder, from `src/agent-profile/`. |

## The interface: `src`

- `App.tsx` only connects hooks to components. New behaviour goes in a hook or in `src/lib`.
- `src/hooks` holds React state and effects, one area per hook (`useLibrary`, `useEnvironments`,
  `useRequestSender`, `useCollections`, `useLocalMocks`, `useMcpServer`, `useAgentChat` and so on).
- `src/components` draws the interface. Folders group the larger areas: `agent-chat`,
  `collections`, `mcp`, `mock-journey` and `settings`.
- `src/lib` holds the logic, with no React, so it can be tested on its own.
- `src/agent-profile` is the text of Studio's instructions for the agent chat's agent.
- `src/styles.css` has the design tokens and every component's styles.

### `src/lib`

**Specs**

| File | What it does |
|---|---|
| `spec.ts` | Parses an OpenAPI document into what the interface uses, and resolves `$ref` on demand. |
| `swagger2.ts` | Converts Swagger 2.0 to OpenAPI 3.0 when a spec is opened. |
| `yaml.ts` | Reads YAML 1.2 with merge keys. |
| `library.ts` | The APIs you work with: where each came from, and refreshing them. |
| `sample.ts` | The Orders API that ships with Studio. |
| `sync.ts` | What re-reading a spec did to tabs, drafts and collections that used it. |
| `specCheck.ts` | Whether an edited spec still loads, and what changed since Studio last read it, for agents. |
| `git.ts` | The git details of a spec file, as the interface words them. |
| `tags.ts` | Turns an OpenAPI tag into a readable group label. |
| `highlight.ts` | A small YAML and JSON tokenizer for the Raw view. |
| `markdown.ts` | Reads spec descriptions and agent messages into plain data, never HTML. |

**Requests and responses**

| File | What it does |
|---|---|
| `editor.ts` | What the operation editor holds and starts from, as plain data. |
| `example.ts` | Builds example values from a schema, for request bodies and local mocks alike. |
| `request.ts` | Builds a request from the editor and sends it through Rust (`http_send`). |
| `targets.ts` | Where a request can go (servers, mocks, Spec0 environments, a typed URL), and what each sends. |
| `env.ts` | Environments, variables, and filling `{{name}}` into a request. |
| `secrets.ts` | Where secret values live, moving them into the credential store, and the fallback file. |
| `oauth.ts` | Getting and caching OAuth 2.0 tokens. |
| `connection.ts` | Certificate trust, proxy, timeout and redirects for each host. |
| `cookies.ts` | The cookies each API holds, read from Rust. |
| `response.ts` | Which declared response a status matches, and what of a response goes into history. |
| `responsePane.ts` | Which response the pane shows, and for which request. |
| `drafts.ts` | Unsent changes, kept per API and operation. |
| `tabs.ts` | The request tabs open across APIs. |
| `scratch.ts` | Scratch requests: requests to any URL, without a spec. |
| `describeSpec.ts` | Describe as a spec: a draft OpenAPI 3.1 document written from recorded requests to one host, with no secrets in it. |
| `history.ts` | The local log of requests sent and what came back. |
| `redact.ts` | Keeps secret values out of history, errors, logs and reports. |
| `shortcuts.ts` | Which request ⌘/Ctrl+Enter sends. |

**Checking responses**

| File | What it does |
|---|---|
| `validate.ts` | Checks a response body against the schema declared for its status, and lists differences. |
| `runner.ts` | Runs every operation in a tag and reports which responses match the spec. |

**Collections**

| File | What it does |
|---|---|
| `collection.ts` | The collection model and its file format (`*.spec0-collection.yaml`). |
| `collectionFile.ts` | Where collections live: Studio's store and linked files, and keeping them in step. |
| `collectionImport.ts` | Works out what kind of collection a file holds before reading it. |
| `postman.ts` | Imports a Postman collection (v2.1 or v2.0). |
| `collectionLink.ts` | Matches each step to its API and operation in the library, and builds new steps. |
| `chain.ts` | Reads and fills one reference to an earlier step, such as `{{steps.order.body.id}}`. |
| `chainLinks.ts` | All the links between a collection's steps, for the Chain view and the link dialog. |
| `collectionRun.ts` | Runs a collection: builds each step's request, sends it, checks it, and decides whether to go on. |
| `runLog.ts` | A run's events, kept so the run can be read, copied or exported later. |
| `runActivity.ts` | Runs in progress and just finished, outside React, for the status bar. |

**Mocks**

| File | What it does |
|---|---|
| `localMock.ts` | How a local mock answers: which operation, which response, which body. |
| `localMockServer.ts` | Starting and stopping local mocks, and answering the requests Rust forwards. |
| `mockJourney.ts` | The steps from a spec to a hosted mock: sign in, choose a team, publish, create. |

**The local MCP server**

| File | What it does |
|---|---|
| `mcp-tools.json` | The tool definitions, read by Rust and the web view. |
| `mcpServer.ts` | Starting, stopping and configuring the server, and answering each tool call. |
| `mcp.ts` | The tools that only read what Studio has stored. |
| `mcpAgent.ts` | The tools that act: sending requests, running collections, starting local mocks. |
| `agentApp.ts` | What those tools need from the running app, such as the active environment with its secret values. |
| `agentPolicy.ts` | What an agent may send, and when Studio asks the developer first. |
| `agentControl.ts` | The developer's side: approvals waiting, the activity log, and stopping agents. |

**Agent chat**

| File | What it does |
|---|---|
| `acpProcess.ts` | Turns the agent process's lines from Rust into the stream the ACP library reads and writes. |
| `acpClient.ts` | Speaks the Agent Client Protocol with `@agentclientprotocol/sdk`. |
| `zodJitless.ts` | Switches zod to jitless mode so the ACP library runs under the app's content security policy. |
| `agentChat.ts` | The chat's settings, attachments, kept conversations, and the note sent with the first message. |
| `agentChatPanel.ts` | Whether the panel is open and what the chat is doing, outside React; the panel's width. |
| `agentChatTest.ts` | Starts an agent, opens a session and stops it, to test a connection. |
| `agentSetup.ts` | The "Set up your agent" view: which agents are found and what each needs. |
| `agentProfile.ts` | Studio's instructions for the agent, sent with the first message when they can't be written to its folder. |

**Spec0**

| File | What it does |
|---|---|
| `spec0.ts` | The client for Spec0's public API: the organisation's catalog, environments and hosted mocks. |
| `publish.ts` | Publishing a local spec to Spec0. |

**The app**

| File | What it does |
|---|---|
| `store.ts` | Reading and writing Studio's files through Rust, or local storage in the browser preview. |
| `navigation.ts` | Where you are in the app, as plain data. |
| `appConsole.ts` | The console's entries for this session, in memory only. |
| `appMenu.ts` | Tells the macOS menu whether a request tab is on screen, for ⌘W. |
| `appUpdates.ts` | Updates to Studio itself. |
| `licences.ts` | The open-source packages Settings → About lists, from a file the build writes (`scripts/third-party-notices.ts`). |
| `notifications.ts` | What the bell shows: agent requests waiting, ones nobody answered, updates a check found, runs agents finished. |
| `deepLink.ts` | Reads `spec0://` links and decides what Studio may do with them. |
| `platform.ts` | The few differences between macOS, Windows and Linux in the web view. |
| `plural.ts` | "1 operation", "2 operations". |

## Three flows

### Sending a request

1. `OperationView.tsx` holds the form. Its values come from `editor.ts` and `example.ts`, and
   unsent changes are kept by `drafts.ts`.
2. Send calls `useRequestSender`, which asks `request.ts` to build the request: `targets.ts`
   decides the base URL, `env.ts` fills `{{name}}` variables (secret values come through
   `secrets.ts`), and `oauth.ts` adds a token if the API uses one.
3. `request.ts` sends it with the `http_send` command. `http.rs` applies the host's settings from
   `connection.ts`, uses the API's jar from `cookies.rs`, and returns the response.
4. `validate.ts` checks the body against the declared schema, `responsePane.ts` shows it next to
   its request, and `history.ts` records it after `redact.ts` removes secret values.

### An MCP tool call

1. `mcp.rs` receives `POST /mcp` on `127.0.0.1`. It requires the per-install bearer token, and
   refuses any `Host` other than its own loopback address and any browser `Origin`, which stops a
   web page reaching it through DNS rebinding. It speaks a small subset of MCP's Streamable HTTP
   transport (JSON responses), and gives each client an `Mcp-Session-Id` only to name the agent.
2. `list_environments` is answered in Rust from `environments.json`, never touching the
   credential store and dropping secret values. Every other call goes to the web view as a
   `studio://mcp-call` event.
3. `ensureBridge` in `mcpServer.ts` receives it, and `answerCall` sends it to `mcp.ts` (tools that
   read) or `mcpAgent.ts` (tools that act). Acting tools check `agentPolicy.ts`, may wait for the
   developer through `agentControl.ts`, and reach the app through `agentApp.ts` and `useAgentApp`,
   so an agent's run goes through the same code as the developer's.
4. `answerCall` redacts the result, the console and activity log record the call (never its
   arguments), and `mcp_respond` sends the answer back through Rust. Tools marked `waitsForUser`
   in `mcp-tools.json` get a long timeout; stopping the server answers every waiting call.

### A local mock answering

1. `local_mock.rs` receives the request on the mock's port on `127.0.0.1` (and `[::1]`). It
   refuses a `Host` that isn't a loopback name, and any browser `Origin` other than `localhost`,
   `127.0.0.1` or `[::1]` on any port (`null` included), for simple requests as well as
   preflights. A request with no `Origin` (a `<script>` or `<img>` load) is refused too when
   `Sec-Fetch-Site` says another site sent it and its `Referer` isn't a page on this computer.
   It answers CORS preflights itself.
2. Everything else goes to the web view as a `studio://local-mock-request` event.
   `ensureLocalMockBridge` in `localMockServer.ts` finds the spec, and `localMock.ts` matches the
   path, picks the response (the lowest 2xx, or one asked for with `X-Mock-Status` or
   `?__status=`) and builds the body with `example.ts`.
3. `local_mock_respond` hands the answer back. Rust frames it, adds
   `X-Content-Type-Options: nosniff`, and drops any header that could break the framing or widen
   CORS. The console notes the request.

## Agent chat

The **Agent** button is in `TitleBar.tsx`, with `⇧⌘J`. Whether the panel is open and what the chat
is doing (`idle`, `running`, or `waiting` on a permission question) live in `agentChatPanel.ts`,
outside React, so the button shows a dot while the panel is closed. The panel is
`src/hooks/useAgentChat.ts` and `src/components/agent-chat/`; it docks beside the page in
`.app-body`, and `clampChatWidth` always leaves the page 580 px.

- **Setup.** `AgentSetup.tsx` shows until an agent has connected. `agentSetup.ts` sorts the agents
  into found and not found and gives each a state (`ready`, `needs-cli`, `needs-key`, `missing`).
  Picking one runs the same connection test as Settings (`agentChatTest.ts`). The install and
  sign-in commands shown are the ones each project documents; keep them in step with Settings →
  Agent chat.
- **The process.** `acp.rs` decides the program from the agent's name (`claude`, `codex`, `gemini`
  or `custom`). A program chosen by hand is saved only after a native confirmation showing the
  exact command, in `agent/commands.json`, which `store_write` can't reach. Each agent runs in its
  own process group (`taskkill /T` on Windows), and every agent stops when Studio quits.
- **The Anthropic key** is stored by `secrets.rs` under one fixed account,
  `agent-chat:anthropic-api-key`, which no variable name can reach. Nothing returns it. `acp_start`
  sets `ANTHROPIC_API_KEY` on the Claude process only, and with no key the agent isn't started, so
  Claude Agent can't fall back to a claude.ai sign-in: the adapter always gets
  `--hide-claude-auth`, and `CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`
  are removed from its environment. The key is replaced with `[hidden]` in the agent's output
  (`hide_secrets`).
- **The protocol.** `acpProcess.ts` turns Rust's line events into a stream, keeping lines that
  arrive before anything listens. `acpClient.ts` sends `initialize`, `session/new` (with Studio's
  MCP server when the chat has one), `session/prompt` and `session/cancel`, and answers
  `session/request_permission`. Studio declines the file system and terminal capabilities, so
  agents use their own tools and ask first. `zodJitless.ts` must load before the ACP library;
  `npm run test:csp` runs a chat under the real security policy to catch a regression.
- **Messages.** `agentChat.ts` handles `@` attachments (always redacted), the note about Studio
  sent with each session's first message (`studioContextNote`, as a `studio://context` resource or
  as text), the suggestions an empty chat shows, and `studioLinkFor` for **Open in Studio** on
  `create_collection` and `run_collection` cards. `markdown.ts` renders agent messages as React
  elements; only `http(s)` links are links.
- **Studio's tools.** With **Give the agent Studio's tools** on, `connect` in `useAgentChat` calls
  `ensureMcpRunning`. Any start, stop or new token (`MCP_STATE_EVENT`) ends the agent's MCP session,
  and the panel offers **Reconnect**.
- **Studio's instructions.** The text is in `src/agent-profile/`. `agent_profile.rs` bundles it and
  `acp_start` writes it into Studio's agent folder as the file that agent reads: `AGENTS.md` for
  Codex and other programs, `CLAUDE.md` for Claude, `GEMINI.md` for Gemini CLI. Writes go only to
  fixed names (`agent_profile::inside`). `instructions.json` records what was written: an
  unchanged file is rewritten when the text changes, and an edited one is left alone until
  **Restore Studio's version**. When the agent works in a folder the user chose, or writing failed,
  `firstMessageNote` in `agentProfile.ts` sends the instructions with the first message instead.
  Bump `agent_profile::VERSION` when the text changes.

Versions are pinned: `@agentclientprotocol/sdk` in `package.json`, and the Claude and Codex
adapters (run through `npx`) as `CLAUDE_ADAPTER` and `CODEX_ADAPTER` in `acp.rs`. Gemini CLI runs
as installed, with `--acp`. Before moving an adapter to a newer version, try a chat with that agent
on each platform.

To try the panel without a real agent, `scripts/fake-acp-agent.mjs` is a stand-in with no model.
A message saying "tool" shows a tool call and asks permission, "mcp" calls Studio's MCP server,
"slow" waits to be stopped, and "attach" lists what it received. In the app, choose
**Another agent** in Settings → Agent chat, with the full path to `node` as the program and the
script's full path as the argument.

## The bell

The bell is `NotificationBell.tsx`, in `TitleBar.tsx`. Its state is `notifications.ts`, in memory
for the session, like the console. It only collects what Studio already knows and makes no
request. `useNotificationSources` in `src/hooks/useNotifications.ts` feeds it from
`agentControl.ts` (approvals waiting, and `onApprovalEnded` for the ones that timed out or were
refused by Stop agents), `runActivity.ts` (runs an agent started), `useUpdater` (a Studio update
a check found) and the library's update marks. The chat panel feeds its own permission questions
with `useChatRequests`. Each source registers how to answer its requests, so **Allow** in the bell
does exactly what the dialog or the chat card does.

While a request waits, the same hook sets the window title ("Spec0 Studio — 1 request waiting")
and calls `requestUserAttention`, which bounces the Dock icon on macOS and flashes the taskbar
button on Windows; both clear when nothing waits. The capability grants
`core:window:allow-request-user-attention` and `core:window:allow-set-title` for this.

## Tests

- **Unit tests** are in `src/lib/__tests__` and run with `npm test` (vitest, in Node). New logic in
  `src/lib` needs tests there. Anything touching auth, secrets or working without an account needs
  a test that would fail if the rule broke.
- **Rust tests** sit beside the code in `src-tauri/src` and run with `cargo test`.
- **`scripts/smoke.ts`** parses real specs, builds examples and validates them. It is the main
  safety net for spec handling; add to it rather than writing a separate harness.
- **`scripts/capture.mjs`** drives the interface in headless Chrome, takes a screenshot of each
  view, and fails on page errors. `scripts/capture-document.mjs` does the same for the Document view.
- **`npm run test:csp`** (`scripts/csp-check.mjs`, with `scripts/csp-fixture.ts`) runs the built
  app in Chrome under its real content security policy, because Node has none.
- **`npm run check:docs`** (`scripts/check-user-docs.mjs`) checks the user guide.
- `scripts/check-attribution.mjs` is the pull request check for AI attribution, and
  `scripts/update-manifest.mjs` writes `latest.json` during a release.
