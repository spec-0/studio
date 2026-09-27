# Contributing

Tauri v2 (Rust shell) + React 18 + TypeScript + Vite. macOS only for now.

This file is the design rationale as much as the build instructions. Most of what
follows is a rule plus the reason it exists — the reason matters more, because it
tells you when the rule stops applying.

## Definition of done

```bash
npm run type-check          # tsc --noEmit
npm test                    # vitest
npm run build               # vite build
npx tauri build             # compiles the Rust shell + bundles the .app
```

All four must pass. For UI changes also run the app (`npm run app`) and exercise
the feature — a type-check proves it compiles, not that it works. `npm run dev`
gives a browser preview for fast styling iteration, but requests to third-party
APIs will hit CORS there; that's expected, and the status bar says which mode
you're in.

## The two rules that define this app

**1. Working locally is not negotiable.** Opening a local or remote spec, browsing
operations and schemas, configuring auth, firing requests, validating responses,
managing environments and history must all work with **no account, no login, and no
network call to spec0**. If a change puts any of that behind a connection, it's
wrong — that constraint is the product's entire positioning.

**2. Requests carry no `Origin`.** Outbound HTTP goes through our own reqwest
command in `src-tauri/src/http.rs`, **not** `tauri-plugin-http`. That plugin
attaches the webview's origin to every request, which makes any CORS-configured
server reject a desktop client. A desktop client is not a browser and has no
origin. Don't reintroduce the plugin.

## Architecture

- **Rust owns four things only**: outbound HTTP (`http.rs`), the sign-in loopback
  listener (`oauth.rs` — a webview can't hold a socket), file IO (`storage.rs`),
  and the OS credential store (`secrets.rs` — only native code can reach it).
  Everything else is React.
- **Secrets are narrow commands too.** The webview names an environment id and a
  variable name; Rust builds the account under one fixed service name. There is no
  command that reads an arbitrary keychain item. Credential stores can't be listed
  portably, so Rust keeps an index of what it wrote (names, never values), and that
  is what lets a renamed or deleted variable be cleaned up. The logic around it —
  migrating from the old plaintext file, falling back to it when the store can't be
  reached, pruning — is in `src/lib/secrets.ts` and tested there. A value that
  can't reach the store falls back to the local file and the UI says so; it is
  never dropped.
- **File IO is narrow commands, not the `fs` plugin.** "Read the file the user just
  picked in a dialog" and "read `~/.spec0/config.json`" are different in kind and
  shouldn't share a scope. The dialog *is* the consent step for the first.
- **`src/lib/` is the logic, `src/components/` is the surface.** Spec parsing,
  example generation, validation, environments, history and the platform client are
  all headless and testable without React.
- **Never dereference a whole spec.** `$ref`s resolve on demand with a seen-set.
  That's why Stripe (7.6 MB, 1440 schemas) parses in ~30 ms and why recursive
  models don't overflow the stack.

## Tests

- New logic in `src/lib/` → cover it. `scripts/smoke.ts` runs the parse → example →
  validate pipeline over real specs and is the regression net for spec handling;
  extend it rather than adding a parallel harness.
- `scripts/capture.mjs` drives the real UI in headless Chrome and screenshots each
  view. It also fails on page errors.
- Anything touching auth, secrets, or the works-offline rule needs a test that
  would fail if the rule broke.

## Don't

**No secrets stored per API.** Auth values belong in an environment as secret
variables, referenced as `{{token}}`. A per-API token store would be a second,
worse secret store.

**Environments supply values, never destinations.** Where a request goes is a
*target* — a spec server, a mock, a platform environment, a typed URL. Don't put a
URL field back on `Environment`, and don't put client environments in the target
list. The two share a word and are opposites: a **platform** environment is a real
place the API runs, reported by the platform; a **client** environment is a local
set of values for a testing scenario, never synced. Both can be active at once and
neither should turn into the other.

**Don't auto-select a destination.** Platform environments join the target list but
are never the initial value — that stays the spec's own first server, which is the
document's declaration rather than a choice made for the developer. This isn't
about protecting anyone from production: a caller who can reach an environment
could reach it without us. It's that where a request goes is theirs to pick, so
Studio offers and doesn't decide.

**Don't infer staleness when the platform reports it.** Comparing the version a
mock actually serves against the one we hold is a fact; the "synced after the mock
was attached" flag is only a fallback for platforms that predate the reported
version. Reintroducing the heuristic as the primary signal turns a fact back into a
guess, and a wrong staleness claim discredits the drift verdict it exists to
protect.

**Don't grow the scratch pad.** There is exactly one, it is unnamed, and it is not
saved — only its contents persist, the way a text buffer does. No second pad, no
naming, no folders, no collection import. A scratch request is the thin end of the
wedge toward becoming a collection manager: with no schema there is no generated
body, no response check and no graph, so every reason to use Studio is absent. It
ships as an escape hatch and only survives as one. Requests worth keeping are worth
describing — the answer is a spec.

**OAuth config lives with the API; the client secret does not.** Client id, token
and authorization URLs and scopes are properties of the API and belong on the
library entry. The client secret is stored as a `{{reference}}` into the
environment's secret store — never a literal, or `library.json` becomes the
per-API secret store we just forbade. Acquired tokens are **cache**, keyed by API
*and* environment (staging and production credentials are two environments), in
their own uncommitted file. There's a test that fails if a secret reaches the
index; don't relax it to make a provider's setup one field shorter.

**A bulk run never invents a parameter value.** Required parameters resolve from
the active environment by name, and an operation whose values aren't there is
**skipped with the reason stated**. Studio generates plausible examples elsewhere —
right for a form a human is about to review, wrong here: a fabricated `{orderId}`
produces a confident 404 that means nothing, and a page of those is worse than a
page of honest skips because it *looks like findings*. For the same reason the
exported report lists what was skipped rather than dropping it; a report that omits
what it didn't run reads as "all clear" when it isn't.

**Read-only methods run by default in a bulk run.** Mutating ones are opt-in per
run and marked. This isn't paternalism about the target — a caller who can reach an
endpoint could reach it without us — it's that "run all" is a bulk action where the
user didn't choose each request, which is different from deliberately firing one
DELETE. Sequential, too: a burst of concurrent requests at an internal service is a
load test nobody asked for.

**Files cross to Rust as paths, never as bytes.** A multipart part carries a path;
Rust reads it. Base64 over the IPC bridge inflates every upload by a third and
holds the whole file in the webview's heap — a 200 MB upload must cost the same as
a 200 KB one. The file dialog is already the consent step for reading it. The same
rule runs the other way: a binary **response** is written to a temp file and only
*previewed* inline under a cap, so "Save as…" is a copy rather than a second
download, and `history.json` never accumulates payloads.

**Content-type decides the body editor, the user doesn't.** The spec already says
whether an endpoint takes JSON, a form or a file upload; a dropdown asking which is
a question the document answered. But don't trust content-type when *reading* a
response: servers mislabel constantly, and `application/octet-stream` is routinely
JSON — a payload that decodes as clean UTF-8 is shown as text whatever the header
claimed, because showing someone replacement characters instead of their response
is the worse failure.

**Certificate trust is per-host and deliberate.** There is no global "ignore TLS
errors" switch, and there must not be: that's how a tool teaches someone to stop
reading warnings, and one bad afternoon then leaves verification off against the
public internet forever. Supplying a private CA bundle is the preferred path and is
*not* the same thing — it's still verification, so it must never carry the same
warning, or the warning stops meaning anything. Whenever a request goes to a host
with verification off, the address bar says so at send time; a decision buried in a
dialog is invisible by the following week.

**The Reference tab renders the document you hold, never a fetch.** The renderer is
handed the spec *text* from the library entry — the same string the Raw tab shows.
Handing it a URL would break offline use and, worse, let the two tabs disagree
about what the spec says, which makes both untrustworthy. For the same reason the
renderer's own request client is off permanently: it fires from the webview, so it
would carry an `Origin` (rule 2) and would bypass environments, auth, per-host
certificate trust and history. Requests go through Studio; that tab reads. It's
loaded with `React.lazy` because it's by a wide margin the largest dependency in
the app — a session that never opens it should pay nothing for it. And it renders
**windowed**: only the visible lines are tokenized, because handing back the 30 ms
parse at the last step by laying out a quarter of a million lines would be a poor
trade.

**Git provenance describes the file, never a deployment.** A branch name beside an
API is one short step from reading as "this is what production is running", which
Studio cannot know — deployments are facts a platform *reports*, never ones a
client infers. So the wording says "this file", the dirty flag exists precisely so
a commit id is never shown as describing bytes that have since been edited, and
there's a test asserting the sentence contains no deployment language. Detection is
best-effort and silent: no repo, no git, or a non-file source shows nothing. It
also never invokes `/usr/bin/git` — on a Mac without Command Line Tools that shim
pops an Xcode installer, and opening a spec must not conjure one.

**Consumers are a count, and the detail lives in the dashboard.** Who consumes an
API is org-governance information with its own screen, approval flow and
permissions; restating a slice of it here would be a second, staler place to read
it. Studio shows the number and links out. Pending grants are included in the total
— a grant awaiting a decision is a real consumer, and hiding it would understate
the blast radius exactly when someone is judging whether a change is safe.

**You publish what you opened from disk, and Studio never picks the version.**
Publishing is offered for `file` sources only: Studio has no editor, so a
platform-sourced document is byte-identical to what the platform already holds and
publishing it back is a no-op wearing a version bump. The refusal is *explained*
where the button would be rather than left as a silence. The version defaults to
`info.version` and is never auto-incremented — an incremented default would be
Studio making a release decision on someone's behalf and hiding it in a
placeholder. A commit sha travels **only when the working file is clean**: a dirty
file's commit does not describe its contents, so sending it would assert something
false. Report what came back — "no changes" and "version unchanged" are the two
outcomes worth knowing and both vanish if the UI collapses everything into
"published".

**Our actions sit in our chrome.** The renderer ships a `Deploy` of its own
pointing at its vendor's hosted product; it's hidden along with the rest of its
toolbar. Putting our verb where theirs was would frame a first-class Studio
capability as a vendor integration and pin its position to a third-party layout
that moves on the next upgrade.

**Cookie jars are per-API.** One shared jar would hand a session from one API's
host to another's on any redirect that crossed between them. Jars live in Rust for
the process lifetime and are never written to disk — persisting a session across
restarts is a credential decision nobody made.

**No `tauri-plugin-http`, no `fs` plugin** (see above).

**No hardcoded brand colours** — the design tokens live in `src/styles.css`.

**No gradients, no more than one accent per region, dark code wells in both
themes.** The aesthetic direction is settled; craft goes into typography, rhythm
and motion.

## The platform client

`src/lib/spec0.ts` talks to the **public V1 API only** (`/api/v1/public/**`,
`Authorization: Bearer` plus an org header) — the same surface the
[spec0 CLI](https://github.com/spec-0/cli) uses. Read the published OpenAPI
document as the source of truth rather than any generated client, which may lag it.
