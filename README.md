<div align="center">

# spec0 Studio

**A desktop API client where the OpenAPI spec is the organising primitive.**

Not a collection you maintain by hand. The spec you already have.

[Download for macOS](https://github.com/spec-0/studio/releases/latest) ·
[Build from source](#build-from-source) · MIT

</div>

---

Most API clients ask you to describe your API a second time. You have a spec that
already says what the endpoints are, what the parameters mean, what the response
should look like — and then you hand-build a collection of requests that says the
same thing, badly, and drifts the moment the API changes.

Studio starts from the spec. Requests are generated from it, responses are checked
against it, and when the spec changes the client changes with it. Nothing to
re-record.

## What it does

**A library of specs, not a bag of requests.** Add an API from a local file, a URL,
or your spec0 catalog — OpenAPI 3.0 and 3.1, YAML or JSON. Switch between them with
⌘P. The spec *text* is stored rather than a file path, so reopening is instant,
survives the file moving, and works with no network.

**Schemas are first-class.** Operations grouped by tag *and* component schemas are
two separate sidebar tabs — schemas aren't buried inside the operations that happen
to use them. Schema detail shows merged `allOf` fields, what it references, what
references it, which operations use it, a generated example, the raw JSON, and an
interactive graph.

**Read the document itself.** Raw and Reference tabs: the text exactly as you
imported it with syntax highlighting, or the same document rendered as a full API
reference. Both work offline with no account. If the spec came from a git working
tree, Studio shows its branch, commit and whether the file is dirty.

**Requests built from the schema.** Parameters are typed by what the spec says they
are — an enum becomes a select, a boolean a toggle. Bodies are pre-populated with
real field names and format-aware values. The base URL is free text, so you can
point at `localhost`, a host the spec never mentions, or `{{baseUrl}}`.

**Requests execute in Rust, so there is no CORS.** No preflight, no browser origin,
no proxy needed to talk to your own API.

**Responses are checked against the spec.** Validated against the schema declared
for the status code actually returned — including fields the response contains that
the spec doesn't declare, which is how drift usually shows up first.

**Conformance runs.** Run a tag or the whole spec and get a verdict per operation.
The assertions come from the spec, so nobody wrote them and they can't rot.
Read-only by default, sequential, cancellable, exportable as markdown for a PR.

**Environments.** Named variable sets interpolated as `{{name}}` into the URL,
parameters, headers, auth and body. A variable can be marked secret — the
environment file then records that it exists and is secret, but not its value, so
the file stays safe to commit. The value goes to your OS credential store.

**OAuth 2.0 that Studio performs for you.** Client credentials, or authorization
code + PKCE through your browser. Token URL, authorize URL and scopes pre-fill from
the spec's declared `oauth2` flows.

**Bodies and responses of every shape.** A JSON editor, a key/value editor for
`x-www-form-urlencoded`, or a per-part editor with file pickers for
`multipart/form-data` — files travel as paths, so uploads aren't bounded by what
fits in a JSON string. Binary responses render inline or offer *Save as…* instead
of being mangled into text.

**The things that decide whether a client works on a corporate network.** Per-host
certificate trust with a private CA bundle, proxy configuration honouring
`HTTPS_PROXY`/`NO_PROXY`, configurable timeouts, redirect control that reports the
chain it followed, and a per-API cookie jar you can inspect and clear.

**History.** Every request recorded locally, searchable and replayable, 30-day
retention. Local only — never synced anywhere.

Keyboard: `⌘↵` send · `⌘O` add API · `⌘P` switch API · `⌘L` library ·
`⌘E` environments · `⌘\` inspector · `⌘1/2/3` tabs · `⌘D` theme · `/` search ·
`Esc` close.

## Optional: connect to spec0

Studio is a complete API client with no account. Connecting a
[spec0](https://spec0.io) organisation adds your team's catalog, spec pull, hosted
mock URLs as base-URL suggestions, and publishing a local spec back to your org.

Signing out reverts to purely local operation and loses nothing.

## Privacy

An API client for internal APIs has no business talking to anyone but your API.

- **No telemetry, no analytics, no crash reporting.** Studio makes no request you
  didn't ask for.
- **The rendered reference makes zero network requests.** The renderer is handed
  the document text, never a URL. A spec whose description references a remote
  image will not load it — that request would tell whoever wrote the spec that you
  opened it.
- **A Content Security Policy on the webview** enforces the above regardless of
  what any bundled dependency decides to do in a future version.
- **Auth values are never stored per API.** They live in an environment where they
  can be marked secret, so there's exactly one secret store rather than a second,
  worse one.
- **Secret values live in your OS credential store**: the macOS Keychain, Windows
  Credential Manager, or the Secret Service on Linux. The environment file records
  only that a variable is secret. History, error messages and exported reports show
  a `{{name}}` reference in place of a secret value.
- **Certificate trust is per-host and deliberate.** There is no global "ignore TLS
  errors" switch, and skipping verification for a host is shown at send time.

## Install

Download the latest `.dmg` from
[Releases](https://github.com/spec-0/studio/releases/latest). Universal binary,
macOS 11 or later, signed and notarized by Apple.

## Build from source

Requires Node 20+ and a Rust toolchain.

```bash
npm install
npm run app            # native window
```

```bash
npm run dev            # browser preview at :5173 — fast UI iteration
```

The browser preview is useful for styling, but requests to third-party APIs will
hit CORS there. That's the whole point of the Rust shell — inside the app, requests
go out through Rust. The status bar tells you which mode you're in.

```bash
npm test               # vitest
npm run type-check     # tsc --noEmit
npm run app:build      # bundle a .app and .dmg
```

## Known limitations

- **macOS only** for now. The Rust shell is portable; the packaging and signing
  work isn't done for other platforms.
- **Swagger 2.0 is rejected** with a message rather than converted. Convert to
  OpenAPI 3 first.
- **Generated example values fall back to type** when a field has no `example`, no
  `format`, and an unrecognised name — so some bodies arrive with `"string"`
  placeholders you'll want to replace.
- **Secrets fall back to a plain file if the OS credential store can't be
  reached.** This mostly affects Linux without a running, unlocked keyring (for
  example GNOME Keyring or KWallet). Studio keeps working, keeps secret values in a
  local file that is not encrypted, and says so in the environments dialog. The
  values move into the credential store the next time Studio starts and can reach
  it.
- The app requests broad outbound HTTP scope, because an API client has to be able
  to reach any host you point it at.

## Performance

Measured against Stripe's published spec — 7.6 MB, 589 operations, 1440 schemas:
**~30 ms to parse, ~16 ms to generate examples for all 1440 schemas.**

That comes from *not* dereferencing the document. `$ref`s resolve on demand with a
seen-set, which is also what stops recursive models from overflowing the stack.

## Licence

MIT. See [LICENSE](LICENSE).
