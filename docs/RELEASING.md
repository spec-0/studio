# Releasing

A release is one GitHub release holding:

| File | What it is |
|---|---|
| `spec0-studio-macos-universal.dmg` (and a copy with the version in its name) | Signed, notarized, stapled universal disk image |
| `spec0-studio-macos-universal.app.tar.gz` | The same app, archived for the in-app updater |
| `spec0-studio-linux-x86_64.AppImage` | Linux, any distribution with WebKitGTK 4.1 |
| `spec0-studio-linux-amd64.deb` | Debian and Ubuntu |
| `spec0-studio-windows-x64-setup.exe` | Windows NSIS installer, per-user. **Not code-signed.** |
| `*.sig` next to each updater file | Update signatures |
| `latest.json` | What the in-app updater reads |
| `SHA256SUMS.txt` | Checksums of every file above |

CI does all of it; this file explains the one-time setup and the failure modes
worth recognising.

## Cutting a release

1. Bump the version in **three** places — they must agree or CI fails before
   building anything:
   - `package.json`
   - `src-tauri/tauri.conf.json`
   - `src-tauri/Cargo.toml`
2. Commit, then tag `vX.Y.Z` and push the tag.
3. The `Release` workflow checks the version and the update key, builds macOS,
   Linux and Windows in parallel, signs and notarizes the Mac build and verifies
   it against Gatekeeper, then creates the release as a draft, uploads
   `latest.json` and checksums, and publishes it.

`workflow_dispatch` runs everything except publishing, which is the way to test a
change to the pipeline without creating a release. The files land as workflow
artifacts, including a `latest.json` pointing at where the next tag would put
them. A manual run works without the update key; it just skips the update files
and says so.

## One-time setup

You need an Apple Developer Program membership and a **Developer ID Application**
certificate — not a Mac App Store certificate. Distribution is direct download, not
the App Store.

### Repository secrets

| Secret | How to produce it |
|---|---|
| `MACOS_CERTIFICATE` | Keychain Access → your Developer ID Application identity → export **the private key together with the certificate** as `.p12` → `base64 -i cert.p12 \| pbcopy` |
| `MACOS_CERTIFICATE_PWD` | the password you set during that export |
| `KEYCHAIN_PASSWORD` | any random string; it secures the throwaway keychain CI creates |
| `APPLE_SIGNING_IDENTITY` | the full string from `security find-identity -v -p codesigning`, e.g. `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_API_KEY_P8` | contents of the App Store Connect API `.p8` |
| `APPLE_API_KEY_ID` | the key id shown next to the key |
| `APPLE_API_ISSUER` | the issuer UUID on the same page |
| `TAURI_SIGNING_PRIVATE_KEY` | the update signing key — see [Update signing key](#update-signing-key) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | its password |

Create the API key under App Store Connect → Users and Access → Integrations. **The
`.p8` downloads exactly once** and there is no recovery path — if you lose it,
revoke the key and make a new one.

### Update signing key

The in-app updater only installs files signed with a key whose **public** half is
built into the app (`plugins.updater.pubkey` in `src-tauri/tauri.conf.json`).
This key has nothing to do with Apple's certificate; it is a separate
[minisign](https://jedisct1.github.io/minisign/) key pair that Tauri makes.

Until it is set up, the public key in the config is the placeholder
`REPLACE_WITH_UPDATER_PUBLIC_KEY`, and a tag build stops in the `preflight` job
with a message saying what is missing.

1. Make the key pair on your own machine, outside the repository. Choose a
   password when asked; GitHub can't store an empty secret.

   ```bash
   mkdir -p ~/.tauri
   npx tauri signer generate -w ~/.tauri/spec0-studio.key
   ```

   This writes the private key to `~/.tauri/spec0-studio.key` and the public key
   to `~/.tauri/spec0-studio.key.pub`.

2. Set the two repository secrets:

   ```bash
   gh secret set TAURI_SIGNING_PRIVATE_KEY -R spec-0/studio < ~/.tauri/spec0-studio.key
   gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD -R spec-0/studio   # paste the password
   ```

3. Put the public key into `src-tauri/tauri.conf.json` in place of the
   placeholder. It is the whole content of the `.pub` file, one line:

   ```bash
   cat ~/.tauri/spec0-studio.key.pub
   ```

   The public key is meant to be public. Commit it.

4. **Back up the private key and its password**, somewhere other than this
   machine (a password manager is fine). This matters more than anything else on
   this page. Every installed copy of Studio trusts only this key. If you lose the
   key or forget the password, you can never ship an update to those copies
   again; everyone would have to download and install a new version by hand. If
   the key leaks, someone else could sign an update those copies would accept, so
   keep it as private as the Apple certificate.

Releases made before the updater existed (0.1.1 and earlier) have no updater in
them. People on those versions need to download the next version by hand once.

### Windows is not code-signed

There is no Windows code-signing certificate, so the installer is unsigned. Don't
add a self-signed certificate to make it look signed; Windows doesn't trust those
either, and it would suggest a check that isn't there. Windows SmartScreen shows
"Windows protected your PC" and "Unknown publisher" when someone runs the
installer. They can go on with **More info** → **Run anyway**. The README says
so. The update files are still signed with the update key above, so the updater
itself still refuses a file that didn't come from this workflow.

Nothing signing-related belongs in the repository. `.p12`, `.p8`, `.cer` and CSRs
are gitignored, and they should live outside the working tree entirely.

## Failure modes

**`errSecInternalComponent` during codesign.** The private key's access control
list doesn't permit `codesign`, so macOS tries to ask a human. On a developer
machine you get a dialog; on CI the job simply hangs until it times out. Fix it
once, permanently:

```bash
security set-key-partition-list -S apple-tool:,apple:,codesign: -s \
  ~/Library/Keychains/login.keychain-db
```

CI does the equivalent against its throwaway keychain — that step is load-bearing,
not hygiene.

**`invalid or unsupported format for signature`.** A previous signing attempt died
and left `.cstemp` files behind. `find . -name "*.cstemp" -delete`, then retry.

**Notarization stuck `In Progress`.** Apple holds some uploads for deeper analysis,
and first submissions from a newly enrolled team are frequently held for hours.
Submissions are server-side, so killing a local `--wait` does not cancel one, and
stapling resolves by **code hash** rather than submission id — any accepted
submission of the same binary yields a valid ticket, so a lost wait costs nothing.

If it lasts more than a day, post the submission UUIDs and their creation dates in
[Code Signing > Notarization](https://developer.apple.com/forums/topics/code-signing-topic/code-signing-topic-notarization)
on the Apple Developer Forums, which is where Apple's DTS engineers answer this.

**Use Xcode's notarytool, not the Command Line Tools one.** Confirm with
`xcrun --find notarytool`; it should resolve inside `Xcode.app`. The Command Line
Tools build reports its version as `unknown (0)`, and submissions made with it were
accepted but never processed. GitHub runners select Xcode by default, so this is
only a hazard if something changes `xcode-select`.

**Never `pkill -f` anything during a release.** A notarytool command line contains
the path of the artifact, so a pattern like `pkill -f "spec0 Studio"` matches the
notarization process and kills the build.

**The disk image needs notarizing too, separately.** Tauri notarizes and staples
the `.app`, then builds a `.dmg` from it and *signs* the image — it does not
notarize the image. A signed-but-unnotarized dmg still raises "Apple cannot check
it for malicious software" on the machine that downloaded it, so the release
workflow submits the dmg as its own second pass and staples that too.

**Don't run `tauri build --bundles dmg` to re-package a stapled app.** It rebuilds
the app bundle from scratch, which silently discards the ticket you just stapled.
The rebuilt app has the same code hash, so `spctl` still says `accepted` — it is
quietly satisfying itself with an *online* lookup, and the app would fail to launch
on a machine with no network. Always build `app,dmg` in one invocation with
notarization credentials present, and check with `stapler validate` rather than
trusting `spctl`.

**`latest.json` is missing a platform.** `scripts/update-manifest.mjs` fails the
publish job if any updater file or its `.sig` is missing. The `.deb` needs its own
entry (`linux-x86_64-deb`): without it, a `.deb` install would be offered the
AppImage and hand it to `dpkg`.

## Verifying a release by hand

```bash
codesign --verify --deep --strict --verbose=2 "spec0 Studio.app"
xcrun stapler validate "spec0 Studio.app"
spctl --assess --type execute --verbose=4 "spec0 Studio.app"
```

The last one is the check that speaks for the end user's machine. It must print:

```
source=Notarized Developer ID
```
