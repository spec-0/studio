# spec0 Studio

spec0 Studio is a desktop app for calling and testing APIs, for developers who
already have an OpenAPI spec (the YAML or JSON file that describes an API).

Instead of building a collection of requests by hand, you open the spec and
Studio builds the requests from it. It then checks each response against what
the spec says, so you notice when the API and its description drift apart.
Studio is young, and we'd like to hear what breaks.

Free and open source (MIT). Works without an account.

<!-- screenshot: main window -->

## Download

These links always point to the newest version:

| Platform | File | Notes |
|---|---|---|
| macOS 11 or later | [spec0-studio-macos-universal.dmg](https://github.com/spec-0/studio/releases/latest/download/spec0-studio-macos-universal.dmg) | Apple silicon and Intel. Signed and notarized by Apple. |
| Windows 10 and 11, x64 | [spec0-studio-windows-x64-setup.exe](https://github.com/spec-0/studio/releases/latest/download/spec0-studio-windows-x64-setup.exe) | Installs for your user only, no admin rights needed. **Not code-signed**, see below. |
| Linux x86_64 | [spec0-studio-linux-x86_64.AppImage](https://github.com/spec-0/studio/releases/latest/download/spec0-studio-linux-x86_64.AppImage) | Most distributions. Run `chmod +x` on it, then run it. |
| Debian, Ubuntu, x86_64 | [spec0-studio-linux-amd64.deb](https://github.com/spec-0/studio/releases/latest/download/spec0-studio-linux-amd64.deb) | `sudo apt install ./spec0-studio-linux-amd64.deb` |

All files are on the [releases page](https://github.com/spec-0/studio/releases/latest).
Each release includes a `SHA256SUMS.txt` file you can check a download against.

**The Windows installer is not code-signed.** We don't have a Windows
code-signing certificate yet. When you run the installer, Windows SmartScreen
will probably say "Windows protected your PC" and call the publisher unknown.
To continue, click **More info**, then **Run anyway**. If you'd rather not, you
can check the file against `SHA256SUMS.txt` first (in PowerShell:
`Get-FileHash .\spec0-studio-windows-x64-setup.exe`), or build Studio from
source. On Windows, Studio uses Microsoft's WebView2 to draw its window. Windows
11 and current Windows 10 already have it; if yours doesn't, the installer
downloads it from Microsoft.

**Updates.** Choose *Check for Updates…* (in the app menu on macOS, the Help menu
on Windows and Linux) to see whether there is a newer version and install it.
Every update is signed, and Studio refuses an update whose signature doesn't
match. An AppImage replaces itself. A `.deb` install asks for your password
(through `pkexec`) to install the new package. On Windows the installer runs and
then Studio starts again.

## What it does

**Your specs**
- Add an API from a local file, a URL, or a spec0 account. OpenAPI 3.0 and 3.1,
  YAML or JSON.
- Studio keeps a copy of the spec's text, so it opens quickly, works offline and
  still works if the file moves.
- Browse operations by tag, and browse schemas (the data models) in their own
  tab: fields, what each schema uses and is used by, an example, and a graph.
- See the spec as raw text or as a readable API reference. Both work offline.
- If the spec file is in a git repository, Studio shows its branch, commit, and
  whether the file has changed since that commit.

**Sending requests**
- Request forms come from the spec: a list of allowed values becomes a dropdown,
  a true/false becomes a toggle, and request bodies start filled in with the
  real field names.
- Point a request anywhere: the spec's server, `localhost`, or any other address.
- Requests are sent by the app itself, not by a web page, so browser CORS rules
  (which stop a web page from calling other sites) don't get in the way. No
  proxy needed.
- JSON bodies, form bodies, and file uploads. Binary responses such as images or
  PDFs show inline or can be saved to disk.

**Checking responses**
- Each response is checked against the schema the spec gives for that status
  code, including fields the API returns that the spec doesn't mention.
- Conformance runs: run every operation in a tag or in the whole spec and see
  which responses match the spec. Only read-only requests (like GET) run unless
  you choose otherwise. Requests run one at a time, can be cancelled, and the
  result can be exported as Markdown.

**Environments and sign-in**
- Environments are named sets of values, such as `{{baseUrl}}` or `{{token}}`,
  that you can use in the URL, headers, auth and body.
- A value can be marked secret. The secret goes into your operating system's
  credential store, and the environment file only notes that the secret exists,
  so the file is safe to commit.
- OAuth 2.0: Studio can get tokens for you, using client credentials or the
  authorization code flow with PKCE in your browser. Settings are pre-filled from
  the spec where it has them.

**Company networks**
- Trust a private certificate authority for specific hosts.
- Proxy settings, including `HTTPS_PROXY` and `NO_PROXY`.
- Timeouts, redirect control (Studio shows each redirect it followed), and a
  cookie jar per API that you can inspect and clear.

**History**
- Every request is saved on your computer for 30 days, and you can search and
  replay it. History is never synced anywhere.

Keyboard shortcuts (use Ctrl instead of ⌘ on Windows and Linux): `⌘↵` send ·
`⌘O` add API · `⌘P` switch API · `⌘L` library · `⌘E` environments ·
`⌘\` inspector · `⌘1/2/3` tabs · `⌘D` theme · `/` search · `Esc` close.

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
  connection settings.

## Connecting to spec0 (optional)

Everything above works without an account. If your team uses
[spec0](https://spec0.io), you can sign in to browse your organisation's APIs,
pull their specs, use hosted mock servers as request targets, and publish a
local spec to your organisation. Signing out returns Studio to local-only use,
and nothing is lost.

## Known limitations

- **The Windows and Linux builds are new** and have had much less use than the
  Mac build. Please [open an issue](https://github.com/spec-0/studio/issues) if
  something looks or works wrong.
- **The Windows installer is not code-signed**, so SmartScreen warns about it
  (see [Download](#download)).
- **Windows and Linux builds are x86_64 only.** There are no ARM builds for them yet.
- **Linux needs WebKitGTK 4.1**: Ubuntu 22.04, Debian 12 or newer, or another
  distribution of about that age.
- **Update checks use Studio's proxy setting, but not its certificate settings.**
  If your network inspects encrypted traffic with a private certificate
  authority, the check may fail. Download new versions from the releases page
  instead.
- **Swagger 2.0 is not supported.** Studio shows a message; convert the spec to
  OpenAPI 3 first.
- **Some example values are placeholders.** When a field has no example, no
  format and an unfamiliar name, Studio fills in something like `"string"`,
  which you'll want to replace.
- **Secrets can fall back to a plain file.** If the credential store can't be
  reached (mostly on Linux without a running, unlocked keyring such as GNOME
  Keyring or KWallet), Studio keeps secret values in a local file that is not
  encrypted, and says so in the environments dialog. The values move to the
  credential store the next time Studio starts and can reach it.
- **The app is allowed to make HTTP requests to any host**, because an API
  client has to reach whatever address you give it.

## Performance

On Stripe's public spec (7.6 MB, 589 operations, 1440 schemas), Studio takes
about 30 ms to read the spec and about 16 ms to build examples for every schema,
on our machines. It gets there by looking up `$ref` references only when they
are needed, rather than expanding the whole document up front. That is also what
keeps schemas that refer to themselves from causing problems.

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

## Contributing

Bug reports, questions and pull requests are welcome. Please read
[CONTRIBUTING.md](CONTRIBUTING.md) first. To report a security problem, see
[SECURITY.md](SECURITY.md) rather than opening a public issue.

## Licence

MIT. See [LICENSE](LICENSE).
