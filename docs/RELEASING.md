# Releasing

A release is a signed, notarized, stapled universal `.dmg` attached to a GitHub
release. CI does all of it; this file explains the one-time setup and the failure
modes worth recognising.

## Cutting a release

1. Bump the version in **three** places — they must agree or CI fails before
   building anything:
   - `package.json`
   - `src-tauri/tauri.conf.json`
   - `src-tauri/Cargo.toml`
2. Commit, then tag `vX.Y.Z` and push the tag.
3. The `Release` workflow builds, signs, notarizes, staples, verifies against
   Gatekeeper, and publishes the release with checksums.

`workflow_dispatch` runs everything except publishing, which is the way to test a
change to the pipeline without creating a release.

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

Create the API key under App Store Connect → Users and Access → Integrations. **The
`.p8` downloads exactly once** and there is no recovery path — if you lose it,
revoke the key and make a new one.

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
