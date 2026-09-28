# Releasing

This page is for maintainers. It covers how a release is made, the one-time
setup, and the problems we have run into along the way.

A release is one GitHub release containing:

| File | What it is |
|---|---|
| `spec0-studio-macos-universal.dmg` (and a copy with the version in its name) | macOS disk image: signed, notarized and stapled, for Apple silicon and Intel |
| `spec0-studio-macos-universal.app.tar.gz` | The same app, packed for the in-app updater |
| `spec0-studio-linux-x86_64.AppImage` | Linux, any distribution with WebKitGTK 4.1 |
| `spec0-studio-linux-amd64.deb` | Debian and Ubuntu |
| `spec0-studio-windows-x64-setup.exe` | Windows installer (NSIS), installs per user. **Not code-signed.** |
| `*.sig` next to each updater file | Update signatures |
| `latest.json` | What the in-app updater reads |
| `SHA256SUMS.txt` | Checksums of every file above |

CI builds and publishes all of it. The file names are fixed (no version number)
so that links of the form `/releases/latest/download/<name>` keep working from
one release to the next.

## Making a release

1. Set the new version in **three** files:
   - `package.json`
   - `src-tauri/tauri.conf.json`
   - `src-tauri/Cargo.toml`

   CI stops before building anything if the tag doesn't match `package.json` and
   `tauri.conf.json`. It doesn't check `Cargo.toml`, so don't forget that one.
2. Write the release notes in `docs/release-notes/vX.Y.Z.md`. Write them for
   people using Studio: what's new, what's fixed, anything they need to know.
   They appear on the release page and in the app's update dialog, so a list of
   commit titles won't do. CI stops before building if the file is missing.
3. Commit, then create the tag `vX.Y.Z` and push it.
4. The `Release` workflow (`.github/workflows/release.yml`) runs these jobs:

   | Job | Runs on | What it does |
   |---|---|---|
   | `preflight` | Ubuntu | Checks that the tag matches the version, and that the update signing key is set up. |
   | `macos` | macOS 15 | Type-check, tests and build; imports the Developer ID certificate into a temporary keychain; builds a universal `.app` and `.dmg`; signs, notarizes and staples both; checks them with Gatekeeper; adds the fixed-name copy of the `.dmg`. |
   | `linux` | Ubuntu 22.04 | Builds the AppImage and `.deb`. Uses the oldest Ubuntu that has WebKitGTK 4.1, because building on a newer one raises the minimum glibc and the files stop starting on older distributions. |
   | `windows` | Windows | Builds the NSIS installer. Not code-signed. |
   | `publish` | Ubuntu | Creates the release as a draft, writes `latest.json` and `SHA256SUMS.txt`, uploads everything, then publishes. |

   The three build jobs run in parallel. When the update key is set up, each one
   also produces its updater file and signs it with that key.

The release is created as a draft first, so `/releases/latest` never points at a
release whose `latest.json` isn't uploaded yet. Its notes come from
`docs/release-notes/<tag>.md`, and the same text goes into `latest.json`, so the
release page and the update dialog always say the same thing.

**Changing notes after publishing.** Editing the release page alone doesn't
change what the update dialog shows. Also update `notes` in `latest.json`,
recompute its line in `SHA256SUMS.txt`, and upload both with
`gh release upload vX.Y.Z latest.json SHA256SUMS.txt --clobber`. The update
signatures cover the downloaded files, not the notes, so they stay valid.

**Test runs.** Running the workflow by hand (`workflow_dispatch`) does
everything except publish. Use it to test a change to the pipeline. The files
are saved as workflow artifacts, including a `latest.json` pointing where the
next tag would put them. A manual run works without the update key; it skips the
update files and says so.

## One-time setup

You need an Apple Developer Program membership and a **Developer ID
Application** certificate (not a Mac App Store certificate). Studio is
downloaded directly, not through the App Store.

### Repository secrets

| Secret | How to get it |
|---|---|
| `MACOS_CERTIFICATE` | Keychain Access → your Developer ID Application identity → export **the private key together with the certificate** as `.p12` → `base64 -i cert.p12 \| pbcopy` |
| `MACOS_CERTIFICATE_PWD` | The password you chose during that export |
| `KEYCHAIN_PASSWORD` | Any random string. It protects the temporary keychain CI creates. |
| `APPLE_SIGNING_IDENTITY` | The full string from `security find-identity -v -p codesigning`, for example `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_API_KEY_P8` | Contents of the App Store Connect API key (`.p8` file) |
| `APPLE_API_KEY_ID` | The key id shown next to the key |
| `APPLE_API_ISSUER` | The issuer UUID on the same page |
| `TAURI_SIGNING_PRIVATE_KEY` | The update signing key, see [Update signing key](#update-signing-key) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Its password |

Create the API key under App Store Connect → Users and Access → Integrations.
**The `.p8` file can be downloaded only once**, and it can't be recovered. If you
lose it, revoke the key and create a new one.

Nothing related to signing belongs in the repository. `.p12`, `.p8`, `.cer` and
certificate request files are gitignored, and are best kept outside the working
folder entirely.

### Update signing key

The in-app updater only installs files signed with a key whose **public** half
is built into the app (`plugins.updater.pubkey` in `src-tauri/tauri.conf.json`).
This key has nothing to do with Apple's certificate. It is a separate
[minisign](https://jedisct1.github.io/minisign/) key pair made by Tauri, and it
signs the update files for all three platforms.

The key in use has the minisign id `DE10FBDDA60B7F58` (decode the `pubkey` value
with `base64 -d` to see it). If the config still holds the placeholder
`REPLACE_WITH_UPDATER_PUBLIC_KEY`, or the secrets are missing, a tag build stops
in the `preflight` job with a message saying what is missing.

`bundle.createUpdaterArtifacts` is `false` in `tauri.conf.json`, so a local
`tauri build` works without the key. The CI build jobs turn it on with
`--config updater.conf.json` when `preflight` confirms the key is set up.

Below is how the key was made, and how to make a new one if it is ever lost.
Replacing the key has a real cost: installed copies trust only the old key, so
their users have to download the next version by hand once.

1. Create the key pair on your own machine, outside the repository. Choose a
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
   placeholder. It is the whole content of the `.pub` file, on one line:

   ```bash
   cat ~/.tauri/spec0-studio.key.pub
   ```

   The public key is meant to be public. Commit it.

4. **Back up the private key and its password** somewhere other than this
   machine (a password manager is fine). This matters more than anything else on
   this page. Every installed copy of Studio trusts only this key. If you lose
   the key or forget the password, you can't ship an update to those copies
   again, and everyone has to download a new version by hand. If the key leaks,
   someone else could sign an update those copies would accept, so keep it as
   private as the Apple certificate.

Releases made before the updater existed (0.1.1 and earlier) don't include it.
People on those versions need to download the next version by hand once.

### Windows is not code-signed

We don't have a Windows code-signing certificate, so the installer is unsigned.
Don't add a self-signed certificate to make it look signed: Windows doesn't trust
those either, and it would suggest a check that isn't there. When someone runs
the installer, Windows SmartScreen shows "Windows protected your PC" and
"Unknown publisher". They can continue with **More info** → **Run anyway**, and
the README explains this. The update files are still signed with the update key
above, so the updater still refuses any file that didn't come from this workflow.

## Problems we have run into

**`errSecInternalComponent` during codesign.** The private key's access list
doesn't allow `codesign`, so macOS tries to ask a person. On your own machine you
get a dialog; on CI the job just hangs until it times out. Fix it once:

```bash
security set-key-partition-list -S apple-tool:,apple:,codesign: -s \
  ~/Library/Keychains/login.keychain-db
```

CI runs the same command against its temporary keychain. That step is required,
not optional tidying.

**`invalid or unsupported format for signature`.** An earlier signing attempt
failed and left `.cstemp` files behind. Run `find . -name "*.cstemp" -delete`,
then try again.

**Notarization stuck at `In Progress`.** Apple holds some uploads for a closer
look, and the first submissions from a newly enrolled team are often held for
hours. Submissions live on Apple's side, so stopping a local `--wait` doesn't
cancel one. Stapling matches by **code hash**, not by submission id, so any
accepted submission of the same binary gives a valid ticket; losing a wait costs
nothing.

If it lasts more than a day, post the submission UUIDs and their creation dates
in [Code Signing > Notarization](https://developer.apple.com/forums/topics/code-signing-topic/code-signing-topic-notarization)
on the Apple Developer Forums. Apple's developer support engineers answer there.

**Use Xcode's `notarytool`, not the Command Line Tools one.** Check with
`xcrun --find notarytool`; the path should be inside `Xcode.app`. The Command
Line Tools version reports itself as `unknown (0)`, and submissions made with it
were accepted but never processed. GitHub's macOS runners use Xcode by default,
so this only matters if something changes `xcode-select`.

**Never `pkill -f` anything during a release.** A `notarytool` command line
includes the path of the file being notarized, so a pattern like
`pkill -f "spec0 Studio"` matches the notarization process and kills the build.

**The disk image has to be notarized separately.** Tauri notarizes and staples
the `.app`, then builds a `.dmg` from it and only *signs* the image. A signed but
un-notarized `.dmg` still shows "Apple cannot check it for malicious software"
on the machine that downloaded it. So the workflow submits the `.dmg` for
notarization as a second step and staples it too.

**Don't run `tauri build --bundles dmg` to re-package a stapled app.** It
rebuilds the app from scratch, which quietly throws away the ticket you just
stapled. The rebuilt app has the same code hash, so `spctl` still says
`accepted`, but only because it looks the ticket up online; the app would fail
to open on a machine with no network. Always build `app,dmg` in one command with
the notarization credentials present, and check with `stapler validate` rather
than relying on `spctl`.

**`latest.json` is missing a platform.** `scripts/update-manifest.mjs` fails the
`publish` job if any updater file or its `.sig` is missing. The `.deb` needs its
own entry (`linux-x86_64-deb`); without it, a `.deb` install would be offered
the AppImage and pass it to `dpkg`.

## Checking a release by hand

On a Mac, with the app copied out of the downloaded `.dmg`:

```bash
codesign --verify --deep --strict --verbose=2 "spec0 Studio.app"
xcrun stapler validate "spec0 Studio.app"
spctl --assess --type execute --verbose=4 "spec0 Studio.app"
```

The last command is the one that reflects what a user's Mac will decide. It must
print:

```
source=Notarized Developer ID
```

On any platform, compare a download against `SHA256SUMS.txt`:

```bash
sha256sum -c SHA256SUMS.txt --ignore-missing      # Linux
shasum -a 256 -c SHA256SUMS.txt --ignore-missing  # macOS
```
