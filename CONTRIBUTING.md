# Contributing

Thanks for taking a look. Studio is built with Tauri v2 (a Rust shell around a
web view), React 18, TypeScript and Vite. It ships for macOS, Windows and Linux;
the Mac build has had the most use so far.

Most of this file is a list of rules, each with the reason behind it. The reason
is the useful part: it tells you when a rule applies and when it doesn't.

## Reporting bugs and asking for features

Questions, ideas and general feedback are best in
[Discussions](https://github.com/spec-0/studio/discussions).

For a bug or a specific feature request, open an
[issue](https://github.com/spec-0/studio/issues/new/choose). For a bug, the most
helpful things are your operating system, the Studio version (shown under
*About*), what you did, what you expected, and what happened. If you can
share a small spec that shows the problem, even better. Please remove any tokens
or private URLs first.

**Security problems:** please don't open a public issue. See
[SECURITY.md](SECURITY.md) for how to report one privately.

## Before you open a pull request

```bash
npm run type-check          # TypeScript check
npm test                    # unit tests (vitest)
npm run build               # production build of the interface
npx tauri build             # builds the Rust shell and the app
```

All four should pass. CI also runs two more checks:

```bash
npm run test:csp            # runs the built app in Chrome under its real security policy
cd src-tauri && cargo test  # the Rust tests, on macOS, Linux and Windows
```

`test:csp` exists because unit tests run in Node, which has no Content Security
Policy. Code that the app's policy blocks (for example a library that uses
`eval`) can pass every unit test and still fail in the real app.

For interface changes, also run the app (`npm run app`) and try the feature.
A passing type-check shows the code compiles, not that it works. `npm run dev`
gives a quicker browser preview for styling, but requests to other sites will be
blocked by CORS there. That's expected; the status bar shows which mode you're in.

For larger changes, it helps to open an issue first so we can agree on the
approach before you spend time on it.

## The two main rules

**1. Everything works locally, without an account.** Opening a spec (local or
remote), browsing operations and schemas, setting up auth, sending requests,
checking responses, and using environments and history must all work with no
account, no sign-in, and no network call to spec0. A change that puts any of
this behind a connection to spec0 is the wrong change.

**2. Requests don't carry an `Origin` header.** Outbound HTTP goes through our
own Rust command in `src-tauri/src/http.rs`, not `tauri-plugin-http`. That plugin
adds the web view's origin to every request, and servers with CORS rules then
reject it. A desktop app isn't a browser and has no origin. Please don't bring
the plugin back.

## How the code is organised

- **Rust does six things**: outbound HTTP (`http.rs`), the local listener used
  during OAuth sign-in (`oauth.rs`, because a web view can't open a socket), file
  reading and writing (`storage.rs`), the OS credential store (`secrets.rs`,
  because only native code can reach it), checking for and installing updates
  (`updates.rs`, with the menu in `menu.rs`), and the local MCP server's socket
  (`mcp.rs`, for the same reason as sign-in). Everything else is React.
- **Secrets go through narrow commands.** The web view passes an environment id
  and a variable name; Rust builds the credential store entry under one fixed
  service name. There is no command that reads an arbitrary keychain item.
  Credential stores can't be listed in a portable way, so Rust keeps an index of
  what it wrote (names only, never values). That index is how a renamed or
  deleted variable gets cleaned up. The logic around it (moving values out of the
  old plain file, falling back to that file when the store can't be reached,
  cleaning up) is in `src/lib/secrets.ts` and tested there. A value that can't
  reach the store falls back to the local file and the interface says so; it is
  never dropped.
- **File access uses narrow commands, not the `fs` plugin.** "Read the file the
  user just picked" and "read `~/.spec0/config.json`" are different kinds of
  access and shouldn't share one permission. For the first, the file picker is
  the user's consent.
- **`src/lib/` holds the logic, `src/components/` holds the interface.** Spec
  parsing, example generation, validation, environments, history and the spec0
  client don't depend on React and can be tested without it.
- **`src/hooks/` holds React state and effects.** Each hook owns one area (the
  library, environments, history, sending a request, and so on). `App.tsx` only
  connects hooks to components; new behaviour goes in a hook or in `src/lib/`,
  not in `App.tsx`.
- **Never expand a whole spec.** `$ref` references are looked up when needed,
  with a record of what has been seen. That keeps large specs fast (Stripe's
  parses in about 30 ms) and stops schemas that refer to themselves from looping
  forever.

## Tests

- New logic in `src/lib/` needs tests. `scripts/smoke.ts` runs the parse,
  example and validate steps over real specs and is the main safety net for spec
  handling. Add to it rather than writing a separate harness.
- `scripts/capture.mjs` drives the real interface in headless Chrome, takes a
  screenshot of each view, and fails on page errors.
- Anything touching auth, secrets, or the works-without-an-account rule needs a
  test that would fail if the rule were broken.

## Design rules, and why

**No secrets stored per API.** Auth values go in an environment as secret
variables, used as `{{token}}`. A separate token store per API would be a second,
weaker place for secrets.

**Environments hold values, not destinations.** Where a request goes is its
*target*: a server from the spec, a mock, a spec0 environment, or a typed URL.
Don't add a URL field to `Environment`, and don't list client environments as
targets. The word "environment" means two opposite things here. A **spec0
environment** is a real place the API runs, reported by spec0. A **client
environment** is a local set of values for testing, never synced. Both can be
active at once, and neither should turn into the other.

**Don't choose the destination for the user.** spec0 environments appear in the
target list but are never selected by default. The default stays the spec's own
first server, because that is what the document says. Where a request goes is
the user's choice; Studio offers options and doesn't decide.

**Use the reported mock version when there is one.** When spec0 reports which
spec version a mock serves, compare that with the version Studio has; that is a
fact. The older "synced after the mock was attached" check is only a fallback
for when no version is reported. A wrong "out of date" message makes people
distrust the drift check it supports.

**Keep the scratch pad small.** There is one scratch request. It has no name and
isn't saved as an item, only its contents are kept, like a text buffer. No second
pad, no names, no folders, no collection import. A scratch request has no schema,
so none of Studio's checks apply to it. It exists as an escape hatch. Requests
worth keeping are worth describing in a spec.

**OAuth settings live with the API; the client secret doesn't.** Client id,
token and authorization URLs and scopes belong to the API and are saved with it
in the library. The client secret is saved as a `{{reference}}` to a secret in
the environment, never as a literal, so that `library.json` never holds secrets.
Tokens Studio receives are a cache, kept per API *and* per environment (staging
and production credentials are different), in their own file that shouldn't be
committed. A test fails if a secret reaches the library file; please don't relax
it.

**A bulk run never makes up a parameter value.** Required parameters come from
the active environment by name. If a value isn't there, the operation is
**skipped, with the reason shown**. Studio generates example values elsewhere,
which is fine for a form someone will read before sending. It's wrong here: an
invented `{orderId}` gives a 404 that means nothing, and a page of those looks
like real findings. For the same reason, the exported report lists what was
skipped, so it doesn't read as "all clear" when it isn't.

**Bulk runs send read-only requests by default.** Requests that change data are
opt-in for each run and clearly marked. In "run all", the user didn't pick each
request, which is different from deliberately sending one DELETE. Requests run
one at a time, too: many requests at once against an internal service is a load
test nobody asked for.

**Files go to Rust as paths, not bytes.** A file upload passes a path and Rust
reads the file. Sending the bytes across the bridge (as base64) would make every
upload a third bigger and hold the whole file in the web view's memory; a 200 MB
upload should cost the same as a 200 KB one. The file picker is already the
consent to read it. It works the other way too: a binary **response** is written
to a temporary file and only previewed, with a size limit, so *Save as…* copies
the file instead of downloading it again, and `history.json` doesn't fill up with
response bodies.

**The content type picks the body editor.** The spec already says whether an
endpoint takes JSON, a form or a file, so Studio doesn't ask. But don't trust the
content type when *reading* a response: servers often label responses wrongly,
and `application/octet-stream` is often JSON. A response that decodes cleanly as
UTF-8 text is shown as text, whatever the header said.

**Certificate checks are per host and deliberate.** There is no global "ignore
TLS errors" switch, and there shouldn't be one: a switch like that teaches people
to stop reading warnings, and it tends to get left on. Adding a private CA bundle
is the preferred option, and it is *not* the same thing, since it still checks
certificates. So it must not show the same warning, or the warning stops meaning
anything. When a request goes to a host with checks turned off, the address bar
says so at send time.

**The Reference tab shows the document Studio has, never a fetched copy.** The
renderer gets the spec *text* from the library, the same text the Raw tab shows.
Giving it a URL would break offline use and could make the two tabs disagree
about the spec. The renderer's own "send request" feature is turned off for good:
it would send requests from the web view, with an `Origin` (rule 2), and skip
environments, auth, certificate settings and history. Requests go through Studio;
that tab is for reading. It loads lazily (`React.lazy`) because it is by far the
largest dependency, so a session that never opens it doesn't pay for it. It also
only draws the lines currently on screen, so large specs stay fast.

**Git details describe the file, never a deployment.** A branch name next to an
API can easily be read as "this is what production runs", which Studio can't
know. So the wording says "this file", the changed-file flag makes sure a commit
id is never shown for content that has since been edited, and a test checks the
wording has no deployment language. Detection is best-effort and silent: no repo,
no git, or a spec that isn't a file shows nothing. It never runs `/usr/bin/git`,
because on a Mac without the Command Line Tools that pops up an Xcode installer,
and opening a spec shouldn't do that.

**Consumers are shown as a count.** Who uses an API is managed in spec0 itself,
with its own permissions and approvals. Copying part of that into Studio would
give a second place to read it that could be out of date. Studio shows the number
and links to spec0. Pending access requests are counted, because they are real
consumers and leaving them out would understate who a change might affect.

**You publish specs you opened from disk, and Studio never chooses the
version.** Publishing is only offered for specs opened from a file. Studio has no
editor, so a spec pulled from spec0 is identical to what spec0 already has, and
publishing it back would change nothing but the version. Where the button would
be, Studio explains why it isn't there. The version defaults to `info.version`
and is never increased automatically; choosing a version is the user's call. A
commit id is sent **only when the file has no uncommitted changes**, because
otherwise the commit doesn't describe the file. Show the actual result: "no
changes" and "version unchanged" are both worth knowing and shouldn't be folded
into "published".

**Studio's own actions sit in Studio's interface.** The reference renderer comes
with a toolbar, including a button for its maker's hosted product. That toolbar
is hidden. Putting our own buttons in its place would tie them to a third-party
layout that can change with any upgrade.

**One cookie jar per API.** A shared jar could pass one API's session to another
API's host on a redirect between them. Jars live in Rust while the app runs and
are never written to disk; keeping a session across restarts would be a decision
about credentials that nobody made.

**No update check the user didn't ask for.** Studio promises it makes no request
you didn't ask for, and an update check is a request. It runs from the menu or
from Settings, or at start only if the user turned that setting on. The setting is off by default,
and a test checks that. The check runs in Rust (`updates.rs`) so it can use the
proxy from Network settings; the updater's JavaScript API isn't available to
the web view.

**The local MCP server is off until the user starts it, and hands out facts,
not requests.** It listens on `127.0.0.1` only, requires the per-install bearer
token on every request, and refuses any `Host` other than its own loopback
address and any browser `Origin`, which is what stops a web page reaching it
through DNS rebinding. Studio makes no request you didn't ask for, and a
listening socket is the same kind of promise, so the server doesn't start by
itself unless the user turned on "start when Studio opens" (off by default).
Agents get specs, URLs and mock details and send requests themselves; adding a
"send this request" tool would make Studio act for a caller the user can't see.

Rust owns the socket, the checks and the protocol (a small hand-written subset
of MCP's Streamable HTTP transport: one `POST /mcp`, JSON responses, no
sessions). Tool calls go to the web view as `studio://mcp-call` events and are
answered by `src/lib/mcp.ts`, which already parses specs and talks to Spec0, and
reads what Studio stored rather than what's on screen. The exception is
`list_environments`, answered in Rust from `environments.json` alone: it never
touches the credential store and drops the value of anything marked secret, so
no bug in the interface can make a secret come back. Tool definitions live in
`src/lib/mcp-tools.json`, read by both sides. Don't add a tool that repeats what
the remote Spec0 MCP server already offers for the whole organisation; this one
is for what only Studio knows.

**No `tauri-plugin-http` and no `fs` plugin** (see above).

**No hard-coded colours.** The design tokens are in `src/styles.css`.

**No gradients, at most one accent colour per area, and dark code blocks in both
themes.** The visual style is settled; effort goes into typography, spacing and
motion.

## Talking to spec0

`src/lib/spec0.ts` uses only spec0's public API (`/api/v1/public/**`, with an
`Authorization: Bearer` token and an organisation header), the same one the
[spec0 CLI](https://github.com/spec-0/cli) uses. When checking what that API
offers, go by its published OpenAPI document rather than a generated client,
which can fall behind it.

## Licence

By contributing, you agree that your contribution is licensed under the
[MIT licence](LICENSE), the same as the rest of the project.
