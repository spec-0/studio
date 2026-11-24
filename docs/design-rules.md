# Design rules

Each rule says what Studio does, why, and where the code enforces it. A review can link to a rule
by its heading, for example
[design-rules.md#7-environments-hold-values-not-destinations](#7-environments-hold-values-not-destinations).

If a change needs to break a rule, say so in the pull request and give the reason. Some rules look
as if they could be relaxed. The reasons below say why they can't.

## 1. Studio makes no request you didn't ask for

Studio is often used with private, internal APIs, so it only talks to servers the user points it
at, when the user says so. A background request, an update check or a listening socket the user
didn't start would each break that promise. Several later rules apply this one: [22](#22-the-reference-tab-shows-the-document-studio-has),
[29](#29-update-checks-run-only-when-asked), [30](#30-the-local-mcp-server-is-off-until-started-and-agents-act-where-the-developer-can-see-them),
[31](#31-a-local-mock-listens-only-after-it-is-started-and-only-for-this-computer) and
[32](#32-a-spec0-link-is-a-suggestion-never-an-instruction).

## 2. Everything works without an account

Opening a spec (local or remote), browsing operations and schemas, auth, sending requests,
checking responses, environments, history, collections, local mocks and the MCP server all work
with no sign-in and no network call to spec0. A change that puts any of this behind a connection to
spec0 is the wrong change. Tests that would fail if this broke are required for anything touching
it.

## 3. Requests go out through Rust, with no `Origin` header

Outbound HTTP goes through Studio's own command in `src-tauri/src/http.rs`, not
`tauri-plugin-http`. That plugin adds the web view's origin to every request, and servers with CORS
rules then reject it. A desktop app isn't a browser and has no origin. Don't bring the plugin back.

## 4. Native access goes through narrow commands

There is no `fs` plugin. "Read the file the user just picked" and "read `~/.spec0/config.json`" are
different kinds of access and shouldn't share one permission; for the first, the file picker is the
user's consent. Writing works the same way: `write_collection` only writes files ending in
`.spec0-collection.yaml`, `write_run_log` only `.spec0-run.json` or `.spec0-run.txt`, and
`write_spec` (Describe as a spec) only a `.yaml` or `.yml` file whose text is an OpenAPI document,
where the user chose to save them. Enforced in `src-tauri/src/storage.rs`.

## 5. No secrets stored per API

Auth values go in an environment as secret variables, used as `{{token}}`. A separate token store
per API would be a second, weaker place for secrets.

## 6. Secrets live in the credential store, and a fallback says so

The web view passes an environment id and a variable name; Rust builds the credential store entry
under one fixed service name, and no command reads an arbitrary keychain item. Credential stores
can't be listed portably, so Rust keeps an index of what it wrote (names only), which is how a
renamed or deleted variable is cleaned up. A value that can't reach the store falls back to a local
file and the interface says so; it is never dropped. Enforced in `src-tauri/src/secrets.rs` and
`src/lib/secrets.ts`.

## 7. Environments hold values, not destinations

Where a request goes is its target: a server from the spec, a mock, a spec0 environment, or a typed
URL. Don't add a URL field to `Environment`, and don't list client environments as targets. The
word means two things here: a spec0 environment is a real place the API runs, reported by spec0; a
client environment is a local set of values for testing, never synced. Both can be active at once,
and neither should turn into the other. See `src/lib/targets.ts` and `src/lib/env.ts`.

## 8. Studio doesn't choose the destination

spec0 environments appear in the target list but are never selected by default. The default stays
the spec's own first server, because that is what the document says. Studio offers options; the
user decides.

## 9. Collections point at specs and never replace them

A step names an API and an operation in it (by `operationId`, with method and path as the
fallback) and keeps only its own inputs: parameter values, headers, a body and a target. It never
copies the operation. That is what lets Studio check each step against its spec and say when a step
no longer matches it. A collection holding its own copy of each request would be the second,
drifting source of truth Studio exists to avoid. So:

- A step that can't find its operation is shown as missing, with a way to link it to another. It
  isn't quietly turned into a free-standing request.
- A collection can hold requests that aren't linked to a spec yet: scratch requests added with
  **Add to collection**, and requests brought in from other tools. They run like scratch requests,
  keep only their own method and URL, and say nothing checks them until they're linked.
- The file (`*.spec0-collection.yaml`, versioned, see `src/lib/collection.ts`) refers to specs by
  their source, relative to the collection file when both are in one folder. It never holds secret
  values: known secrets are written as `{{references}}` and a literal auth value is left out, with
  a warning.
- A value from an earlier step is a reference, `{{steps.<key>.body.id}}`, picked by clicking it.
  There is no scripting. A reference that can't be filled fails the step before anything is sent,
  with the reason.
- A linked file is re-read when the collection opens and when the window gets focus. It is reloaded
  if nothing in Studio is unsaved; otherwise the user chooses. Saving never overwrites a file that
  changed since Studio read it.
- A local mock is stored as a target kind, never as an address: its port belongs to this computer
  and can change.

## 10. Never expand a whole spec

`$ref` references are looked up when needed, with a record of what has been seen. That keeps large
specs fast (Stripe's parses in about 30 ms) and stops schemas that refer to themselves from looping
forever. See `deref` in `src/lib/spec.ts`.

## 11. Swagger 2.0 is converted when it's opened

Everything after `readDocument` in `src/lib/spec.ts` sees OpenAPI 3 only; the library keeps the
imported text, which the Raw tab shows. The converter is Studio's own (`src/lib/swagger2.ts`)
because `swagger2openapi` is written for Node and would need shimming to run in the web view.
Publishing sends the converted OpenAPI 3.0 text, because Spec0 takes 3.0 and 3.1.

## 12. Scratch requests stay plain

Trying a few endpoints of an API before there's a spec is a real way to start, so there can be as
many scratch requests as you like, each with its own tab and last response. They stay plain: no
names, no folders, no Save. Each is kept like a text buffer until it's removed. They have no schema,
so none of Studio's checks apply to them. Keeping one with others means adding it to a collection
(rule [9](#9-collections-point-at-specs-and-never-replace-them)), and a request worth checking is
worth describing in a spec. **Describe as a spec** writes a draft of one from what History recorded,
sending nothing and leaving credentials out (`src/lib/describeSpec.ts`). The result is an ordinary
file in the library, edited like any spec. Don't grow scratch requests into a second kind of
collection.

## 13. OAuth settings live with the API; the client secret doesn't

Client id, token and authorization URLs and scopes belong to the API and are saved with it in the
library. The client secret is saved as a `{{reference}}` to a secret in the environment, so
`library.json` never holds secrets. Tokens Studio receives are a cache, kept per API and per
environment, in their own file. A test fails if a secret reaches the library file; don't relax it.

## 14. A bulk run never makes up a parameter value

Required parameters come from the active environment by name. If a value isn't there, the
operation is skipped, with the reason shown. Generated examples are fine in a form someone reads
before sending, but an invented `{orderId}` gives a 404 that means nothing, and a page of those
looks like real findings. The exported report lists what was skipped, so it doesn't read as "all
clear" when it isn't. See `src/lib/runner.ts`.

## 15. Bulk runs send read-only requests by default, one at a time

Requests that change data are opt-in for each run and clearly marked. In "run all" the user didn't
pick each request, which is different from deliberately sending one `DELETE`. Running them one at a
time avoids a load test against an internal service that nobody asked for.

## 16. Files go to Rust as paths, not bytes

A file upload passes a path and Rust reads the file. Sending the bytes across the bridge as base64
would make every upload a third bigger and hold it in the web view's memory; a 200 MB upload should
cost the same as a 200 KB one. A binary response is written to a temporary file and only previewed,
with a size limit, so **Save as…** copies the file and `history.json` doesn't fill with bodies.

## 17. The response pane shows only the answer to the request on screen

Picking another operation, API or the scratch pad takes the answer off screen, and a send still in
flight when you move goes to History only. Going back to a request in the same session brings its
last answer back, marked as restored, with the time it was sent, and saying so if the request was
edited since. A bare response next to a request reads as that request's answer. These answers live
in memory only (`src/lib/responsePane.ts`); after a restart, the last response is in History.

## 18. Unsent changes belong to the operation, not the tab

Drafts (`src/lib/drafts.ts`) are kept per API and operation, so closing a tab loses nothing and the
sidebar still shows the dot. A draft is "changed" against what was last sent from it, or against
the spec's examples when nothing was; Discard goes back to the spec. `drafts.json` is written like a
collection file: known secrets become `{{references}}`, and an auth value that isn't a reference
stays in memory and is never written. Tabs (`src/lib/tabs.ts`) are only a list of open operations.

## 19. ⌘W belongs to the macOS menu

File → Close Tab (`src-tauri/src/menu.rs`) closes the request tab on screen, and the window only
when there is none, with ⇧⌘W for the window. The web view is told whether a tab is on screen and
doesn't handle ⌘W itself in the macOS app, or one press would close two tabs. On Windows and Linux
there is no menu item and Ctrl+W is handled in the web view.

## 20. The content type picks the body editor, not how a response is read

The spec already says whether an endpoint takes JSON, a form or a file, so Studio doesn't ask. A
response's content type isn't trusted: servers often label responses wrongly, and
`application/octet-stream` is often JSON. A response that decodes cleanly as UTF-8 is shown as text.

## 21. Certificate checks are per host and deliberate

There is no global "ignore TLS errors" switch, and there shouldn't be one: it teaches people to stop
reading warnings, and it tends to get left on. Adding a private CA bundle is the preferred option,
and it is not the same thing, since it still checks certificates, so it must not show the same
warning. When a request goes to a host with checks turned off, the address bar says so at send
time. See `src/lib/connection.ts`.

## 22. The Reference tab shows the document Studio has

The renderer gets the spec text from the library, the same text the Raw tab shows. Giving it a URL
would break offline use and could make the two tabs disagree. Its own "send request" feature is off
for good: it would send from the web view with an `Origin` (rule [3](#3-requests-go-out-through-rust-with-no-origin-header))
and skip environments, auth, certificates and history. It loads lazily because it is the largest
dependency, and draws only the lines on screen. See `src/components/ScalarReference.tsx`.

## 23. Studio's own actions sit in Studio's interface

The reference renderer comes with a toolbar, including a button for its maker's hosted product.
That toolbar is hidden. Putting Studio's buttons in its place would tie them to a third-party
layout that can change with any upgrade.

## 24. Git details describe the file, never a deployment

A branch name next to an API can be read as "this is what production runs", which Studio can't
know. The wording says "this file", a commit id is never shown for content edited since, and a test
checks the wording has no deployment language. Detection is best-effort and silent, and never runs
`/usr/bin/git`, because on a Mac without the Command Line Tools that opens an Xcode installer. See
`src-tauri/src/git.rs`.

## 25. Use the reported mock version when there is one

When spec0 reports which spec version a hosted mock serves, compare it with the version Studio has;
that is a fact. The older "synced after the mock was attached" check is only a fallback for when no
version is reported. A wrong "out of date" message makes people distrust the drift check it
supports.

## 26. Consumers are shown as a count

Who uses an API is managed in spec0, with its own permissions and approvals. Copying part of it into
Studio would give a second place to read it that could be out of date. Studio shows the number and
links to spec0. Pending access requests are counted, because they are real consumers.

## 27. You publish specs you brought in, and Studio never chooses the version

Publishing is offered for specs opened from a file or a URL, because Studio stores their full text
and what gets published is exactly what Studio shows. It isn't offered for a spec pulled from
spec0 (Studio has no editor, so publishing it back would change only the version) or the bundled
sample. The version defaults to `info.version` and is never increased automatically. A commit id is
sent only when the file has no uncommitted changes. "No changes" and "version unchanged" are shown
as such, not folded into "published". See `src/lib/publish.ts`.

## 28. One cookie jar per API

A shared jar could pass one API's session to another API's host on a redirect between them. Jars
live in Rust while the app runs (`src-tauri/src/cookies.rs`) and are never written to disk; keeping
a session across restarts would be a decision about credentials nobody made.

## 29. Update checks run only when asked

An update check is a request (rule [1](#1-studio-makes-no-request-you-didnt-ask-for)). It runs from
the menu or Settings, or at start only if the user turned that on; the setting is off by default,
and a test checks that. The check runs in Rust (`src-tauri/src/updates.rs`) so it uses the proxy
from Network settings.

## 30. The local MCP server is off until started, and agents act where the developer can see them

A listening socket is the same kind of promise as rule [1](#1-studio-makes-no-request-you-didnt-ask-for),
so the server doesn't start by itself unless the user turned on "start when Studio opens" (off by
default). The one other start is the agent chat: with "Give the agent Studio's tools" on, sending
the first message starts it for that agent. Agents can send requests, run collections, start
local mocks and add specs to the library, because that is how a developer working through an agent tests an API. What keeps
that safe is in `src/lib/agentPolicy.ts` and `src/lib/agentControl.ts`, and none of it should be
relaxed:

- The first request to each host waits for the developer's answer. `DELETE`, `PUT` and `PATCH` to
  a host not on this computer need their own answer. Blocked hosts are refused, and there is a cap
  per minute.
- Starting a local mock asks (it opens a port), and saving a collection file asks every time, with
  the path shown.
- Adding a spec to the library (`open_spec`) asks every time, with the path or URL shown, and goes
  through the same parse and Swagger 2.0 conversion as **Open** (`addSpecText` in
  `src/lib/library.ts`). Fetching a URL is a request, so it follows the host rules above: a blocked
  host is refused without asking and the fetch counts towards the cap. Allowing it doesn't allow
  the host for later requests. A spec already in the library isn't added again.
- The agent never sees a secret value. It writes `{{token}}` and Studio fills it in; every tool
  result is redacted on its way out (`answerCall` in `src/lib/mcpServer.ts`).
- Everything an agent does is visible: the console names the agent, its runs are marked, and the
  MCP tab keeps an activity log. Stop agents refuses whatever is waiting and stops the server.
- Collections an agent creates are drafts, and agents change only their own drafts.
- Don't add a tool that repeats what the remote Spec0 MCP server already offers for the whole
  organisation; this server is for what only Studio knows.

How the server is built, and how it refuses other hosts and web pages, is in
[ARCHITECTURE.md](../ARCHITECTURE.md#an-mcp-tool-call).

## 31. A local mock listens only after it is started, and only for this computer

Each mock is one API on its own port on `127.0.0.1` (and `[::1]`), 4010 upwards, remembered per
API, so the spec's paths work unchanged; one shared port with a prefix per API would make every
frontend rewrite its base path. There is no "start with Studio" setting, and the MCP tool that
starts one asks first. There is no auth, since a token would stop a frontend from simply pointing
at it; instead it refuses other hosts and other websites, as described in
[ARCHITECTURE.md](../ARCHITECTURE.md#a-local-mock-answering). Responses are built with the same
`example.ts` rules as the request editor, so what Studio pre-fills and what the mock returns can't
drift apart.

## 32. A `spec0://` link is a suggestion, never an instruction

Any web page can trigger one, so Studio asks before it downloads anything and shows the host the
spec comes from, which is what the user agrees to. Rust (`src-tauri/src/deep_link.rs`) only
receives and queues links; it has no command that fetches. The rules (only `spec0://open`, only
`https` on a public host, no credentials in the address, the name shown as plain text) are in
`src/lib/deepLink.ts`. A spec already in the library opens from the saved copy, still after the
same confirmation. Cancel has focus, so a reflexive Enter does nothing.

## 33. Studio talks to spec0 only through its public API

`src/lib/spec0.ts` uses spec0's public API (`/api/v1/public/**`, with a bearer token and an
organisation header), the one the [spec0 CLI](https://github.com/spec-0/cli) uses. When checking
what that API offers, go by its published OpenAPI document rather than a generated client, which
can fall behind it.

## 34. No hard-coded colours

The design tokens are in `src/styles.css`. Use them, so both themes stay right.

## 35. No gradients, one accent per area, and dark code blocks in both themes

The visual style is settled. Effort goes into typography, spacing and motion.
