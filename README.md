<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/spec0-studio-dark.svg">
    <img alt="Spec0 Studio" src=".github/assets/spec0-studio-light.svg" width="340">
  </picture>
</h1>

<p align="center">
  <a href="https://github.com/spec-0/studio/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/spec-0/studio?label=release&color=5B4CF5"></a>
  <a href="https://github.com/spec-0/studio/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/spec-0/studio/ci.yml?branch=main&label=CI"></a>
  <a href="LICENSE"><img alt="MIT licence" src="https://img.shields.io/github/license/spec-0/studio?color=52525B"></a>
</p>

**Spec0 Studio** is a desktop app for calling and testing APIs, built around your
OpenAPI spec.

<p align="center">
  <img alt="Opening the Swagger Petstore spec from a URL in Spec0 Studio, sending a request that passes the schema check, then looking at it in History" src=".github/assets/studio-demo.gif" width="900">
</p>

It's for developers who already have an OpenAPI spec (the YAML or JSON file that
describes an API). You open the spec, Studio builds the requests from it, and each
JSON response is checked against the schema the spec declares, so you notice when
the API and its description drift apart.

Studio is free and open source (MIT) and works without an account. It's young,
and we'd like to hear what breaks.

## Download

These links always point to the newest version:

| Platform | File | Notes |
|---|---|---|
| macOS 11 or later | [spec0-studio-macos-universal.dmg](https://github.com/spec-0/studio/releases/latest/download/spec0-studio-macos-universal.dmg) | Apple silicon and Intel. Signed and notarized by Apple. |
| Windows 10 and 11, x64 | [spec0-studio-windows-x64-setup.exe](https://github.com/spec-0/studio/releases/latest/download/spec0-studio-windows-x64-setup.exe) | Installs for your user only, no admin rights needed. Not code-signed, see the note below. |
| Linux x86_64 | [spec0-studio-linux-x86_64.AppImage](https://github.com/spec-0/studio/releases/latest/download/spec0-studio-linux-x86_64.AppImage) | Most distributions. Run `chmod +x` on it, then run it. |
| Debian, Ubuntu, x86_64 | [spec0-studio-linux-amd64.deb](https://github.com/spec-0/studio/releases/latest/download/spec0-studio-linux-amd64.deb) | `sudo apt install ./spec0-studio-linux-amd64.deb` |

- All files are on the [releases page](https://github.com/spec-0/studio/releases/latest).
  Each release includes a `SHA256SUMS.txt` file you can check a download against.
- On Windows, Studio uses Microsoft's WebView2 to draw its window. Windows 11 and
  current Windows 10 already have it; if yours doesn't, the installer downloads it
  from Microsoft.
- The Linux builds need WebKitGTK 4.1: Ubuntu 22.04, Debian 12 or newer, or
  another distribution of about that age.

> [!NOTE]
> The Windows installer isn't code-signed yet, because we don't have a Windows
> code-signing certificate. Windows SmartScreen will probably say "Windows
> protected your PC" and call the publisher unknown. To continue, click
> **More info**, then **Run anyway**. If you'd rather not, check the file against
> `SHA256SUMS.txt` first (in PowerShell: `Get-FileHash .\spec0-studio-windows-x64-setup.exe`),
> or [build Studio from source](#build-from-source).

### Updates

Choose *Check for Updates…* (in the app menu on macOS, the Help menu on Windows
and Linux), or *Check for updates now* in Settings under Updates, to see whether
there is a newer version and install it.

- Every update is signed, and Studio refuses an update whose signature doesn't match.
- An AppImage replaces itself.
- A `.deb` install asks for your password (through `pkexec`) to install the new package.
- On Windows the installer runs and then Studio starts again.

## How this differs

If you use Postman, Insomnia, Bruno or Yaak, the main differences are:

- **It starts from your OpenAPI spec.** Requests are built from the spec, not from
  a collection you maintain alongside it.
- **It checks responses against the spec.** Each JSON response is validated
  against the schema the spec declares for that status code, and fields the spec
  doesn't mention are flagged.
- **It works with no account and sends no telemetry.** History and environments
  stay on your machine, and secrets go in your operating system's credential store.
- **It's younger and does less.** There is no scripting, no shared team workspace,
  no collection import, and no gRPC or WebSocket support. Mock servers are
  available only through the optional [Spec0 connection](#connecting-to-spec0-optional).

## Features

The top bar has four tabs: **APIs** (your library and the API you have open),
**History**, **Mocks** and **MCP**. An open API has its own tabs underneath:
**Operations**, **Schemas**, **Graph** and **Document**. The environment picker,
whether you're local or signed in, and Settings (⌘, or Ctrl+,) are on the right.

### Your specs

- **Three sources.** Add an API from a local file, a URL, or a Spec0 account.
  OpenAPI 3.0 and 3.1, YAML or JSON.
- **Swagger 2.0 too.** Studio converts a Swagger 2.0 spec to OpenAPI 3.0 when you
  open it, on your computer, and says so on the API. The Raw tab still shows the
  file as imported.
- **Open in Studio.** "Open in Studio" buttons on Spec0's public API registry
  (links starting with `spec0://`) open the API here, after you confirm.
  Studio shows where the spec would be downloaded from and fetches nothing
  until you press Open.
- **Kept locally.** Studio keeps a copy of the spec's text, so it opens quickly,
  works offline and still works if the file moves.
- **Operations and schemas.** Browse operations by tag, and browse schemas (the
  data models) in their own tab: fields, what each schema uses and is used by, and
  an example. The Graph tab shows how the schemas refer to each other.
- **Raw and reference views.** The Document tab shows the spec as raw text or as
  a readable API reference. Both work offline.
- **Git details.** If the spec file is in a git repository, Studio shows its
  branch, commit, and whether the file has changed since that commit.

### Sending requests

- **Forms from the spec.** A list of allowed values becomes a dropdown, a
  true/false becomes a toggle, and request bodies start filled in with the real
  field names.
- **Any target.** Point a request at the spec's server, `localhost`, or any other address.
- **No CORS problems.** Requests are sent by the app itself, not by a web page, so
  browser CORS rules (which stop a web page from calling other sites) don't get in
  the way. No proxy needed.
- **Bodies and files.** JSON bodies, form bodies, and file uploads. Binary
  responses such as images or PDFs show inline or can be saved to disk.

### Checking responses

- **Schema checks.** Each response is checked against the schema the spec gives
  for that status code, including fields the API returns that the spec doesn't mention.
- **Conformance runs.** Run every operation in a tag or in the whole spec and see
  which responses match the spec. Only read-only requests (like GET) run unless
  you choose otherwise. Requests run one at a time, can be cancelled, and the
  result can be exported as Markdown.

> [!IMPORTANT]
> Only JSON response bodies are checked against the spec. Headers, content types,
> and status codes the spec doesn't list aren't checked yet.

### Environments and sign-in

- **Environments** are named sets of values, such as `{{baseUrl}}` or `{{token}}`,
  that you can use in the URL, headers, auth and body.
- **Secrets.** A value can be marked secret. The secret goes into your operating
  system's credential store, and the environment file only notes that the secret
  exists, so the file is safe to commit.
- **OAuth 2.0.** Studio can get tokens for you, using client credentials or the
  authorization code flow with PKCE in your browser. Settings are pre-filled from
  the spec where it has them.

### Company networks

These are in Settings, under Network.

- **Private certificate authorities** can be trusted for specific hosts.
- **Proxy settings**, including `HTTPS_PROXY` and `NO_PROXY`.
- **Timeouts and redirects.** Redirect control (Studio shows each redirect it
  followed), and a cookie jar per API that you can inspect and clear.

### History

- **Local, for 30 days.** Every request is saved on your computer with what came
  back and the check result. One list covers all your APIs and scratch requests,
  and you can filter it by API, status, drift, or mock and real.
- **Read-only.** A saved request opens read-only. To run it again, copy it to a
  new request. History is never synced anywhere.

### Keyboard shortcuts

Use Ctrl instead of ⌘ on Windows and Linux.

| Keys | Action | Keys | Action |
|---|---|---|---|
| `⌘↵` | Send | `⌘E` | Environments |
| `⌘O` | Add API | `⌘\` | Response pane |
| `⌘P` | Switch API | `⌘1` to `⌘4` | Operations, Schemas, Graph, Document |
| `⌘L` | All APIs | `⌘D` | Theme |
| `/` | Search | `⌘,` | Settings |
| `Esc` | Close | | |

### Performance

On Stripe's public spec (7.6 MB, 589 operations, 1440 schemas), Studio takes
about 30 ms to read the spec and about 16 ms to build examples for every schema,
on our machines. It gets there by looking up `$ref` references only when they
are needed, rather than expanding the whole document up front. That is also what
keeps schemas that refer to themselves from causing problems.

## Privacy

Studio is often used with private, internal APIs, so it should talk only to the
servers you point it at.

- **No telemetry, analytics or crash reporting.** Studio makes no request you
  didn't ask for.
- **The API reference view makes no network requests.** It is given the spec's
  text, never a URL. If a spec's description links to a remote image, the image
  is not loaded, because loading it would tell the spec's author that you opened it.
- **A Content Security Policy** (a set of rules the app's window enforces) blocks
  other network requests from the interface, whatever a bundled library tries to do.
- **Auth values are not stored per API.** They go in an environment, where they
  can be marked secret. There is one place for secrets, not two.
- **Secret values are kept in your operating system's credential store**: the
  macOS Keychain, Windows Credential Manager, or the Secret Service on Linux.
  History, error messages and exported reports show `{{name}}` in place of a
  secret value.
- **Certificate checks are never switched off everywhere at once.** You can turn
  them off for one host at a time, and Studio reminds you when you send a
  request to that host.
- **Update checks happen only when you ask.** *Check for Updates…* sends one
  request to github.com for the latest release. There is a setting to check each
  time Studio starts; it is off unless you turn it on. The check sends nothing
  about your specs, environments or history, and it uses the proxy from your
  Network settings.
- **Links from web pages ask first.** A `spec0://` link can be triggered by any
  web page, so Studio shows the API's name, the host it would download from and
  the full address, and downloads nothing until you press Open. It only accepts
  `https` addresses on public hosts: never `localhost`, your private network,
  or an address with a password in it.
- **The local MCP server exists only when you turn it on.** It listens on this
  computer only (`127.0.0.1`), answers only requests that carry its token, turns
  away web pages, and stops when Studio quits. It never shares secret values.

> [!WARNING]
> If the credential store can't be reached (mostly on Linux without a running,
> unlocked keyring such as GNOME Keyring or KWallet), Studio keeps secret values
> in a local file that is not encrypted, and says so in the environments dialog.
> The values move to the credential store the next time Studio starts and can reach it.

## Connecting to Spec0 (optional)

Everything above works without an account. If your team uses
[Spec0](https://spec0.io), you can sign in to browse your organisation's APIs,
pull their specs, use hosted mock servers as request targets, and publish a
local spec to your organisation. The Mocks tab lists your organisation's hosted
mock servers. Sign in and out in Settings, under Account & Spec0. Signing out
returns Studio to local-only use, and nothing is lost.

## Local MCP server

Studio can run a small [MCP](https://modelcontextprotocol.io) server so that AI
coding agents on your computer, such as Claude Code or Cursor, can ask it about
your APIs, including specs you haven't published anywhere.

**Turning it on.** Open the **MCP** tab (or Settings → MCP) and press *Start*.
The panel shows the address (`http://127.0.0.1:47321/mcp` unless that port is
taken), a token, and setup commands to copy for Claude Code, Cursor and other
clients. It is off until you start it. You can ask for it to start with Studio;
that is off by default too.

**What agents can see.** The APIs in your library (titles, versions, servers,
operations and the spec text), your environments' variable names and the values
of variables that aren't secret, and whether you're signed in to Spec0. When you
are signed in, agents can also get an API's hosted mock server (its address and
key) and create or rebuild one for an API that's already published.

**What it doesn't do.** Agents don't send requests through Studio: they get
URLs and call them themselves. Secret values are never shared. For searching
every API in your organisation, use the Spec0 MCP server instead; this one only
knows what's on your computer.

**Privacy.** The server listens on `127.0.0.1` only, so other computers can't
reach it. Every request needs the token, which is generated on your computer
(you can make a new one at any time). Requests from web pages are refused. The
server runs only while Studio is open.

## Known limitations

- **Only JSON response bodies are checked** (see [Checking responses](#checking-responses)).
- **The Windows and Linux builds are new** and have had much less use than the
  Mac build. Please [open an issue](https://github.com/spec-0/studio/issues) if
  something looks or works wrong.
- **The Windows installer is not code-signed**, so SmartScreen warns about it
  (see [Download](#download)).
- **Windows and Linux builds are x86_64 only.** There are no ARM builds for them yet.
- **Linux needs WebKitGTK 4.1** (see [Download](#download)).
- **Update checks use Studio's proxy setting, but not its certificate settings.**
  If your network inspects encrypted traffic with a private certificate
  authority, the check may fail. Download new versions from the releases page
  instead.
- **Some example values are placeholders.** When a field has no example, no
  format and an unfamiliar name, Studio fills in something like `"string"`,
  which you'll want to replace.
- **Secrets can fall back to a plain file** when there is no credential store
  (see [Privacy](#privacy)).
- **The app is allowed to make HTTP requests to any host**, because an API
  client has to reach whatever address you give it.

## Build from source

You need Node 20 or later and a Rust toolchain. On Linux you also need
[Tauri's system packages](https://v2.tauri.app/start/prerequisites/#linux)
(WebKitGTK 4.1 and a few others).

```bash
npm install
npm run app            # run the desktop app
npm run dev            # preview the interface in a browser at localhost:5173
```

The browser preview is handy for styling, but requests to other sites will be
blocked by CORS there, because it is a web page. In the desktop app they go out
through Rust. The status bar tells you which one you are in.

```bash
npm test               # unit tests
npm run type-check     # TypeScript check
npm run app:build      # installers for your platform (.dmg, .AppImage/.deb, .exe)
```

## Feedback and contributing

- **Questions, ideas, or "I tried it, here's what I thought"**: start a thread in
  [Discussions](https://github.com/spec-0/studio/discussions).
- **Bugs**: [open an issue](https://github.com/spec-0/studio/issues/new/choose).
- **Security problems**: report them privately, as described in [SECURITY.md](SECURITY.md),
  rather than in a public issue.
- **Pull requests** are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## Licence

MIT, copyright (c) 2026 Spec0. See [LICENSE](LICENSE).
The Spec0 name and logo are used to identify this project and aren't covered by the MIT licence.
