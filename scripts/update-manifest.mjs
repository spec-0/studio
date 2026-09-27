/**
 * Write `latest.json`, the file the in-app updater reads to learn about a new
 * version. Run by the release workflow's publish job.
 *
 *   node scripts/update-manifest.mjs <assets-dir> <tag> <notes-file> <out-file>
 *
 * `<assets-dir>` holds the stable-named release files and their `.sig`
 * signatures (made by `tauri build` with the update signing key). Each
 * platform entry points at the file inside *this tag's* release, so an old
 * `latest.json` never points at newer bytes.
 *
 * Platform keys follow what the updater looks up: `{os}-{arch}-{installer}`
 * first, then `{os}-{arch}`. A `.deb` install needs its own `-deb` key — without
 * it the updater would fall back to `linux-x86_64` and try to install the
 * AppImage with dpkg — so a missing `.deb` signature fails the run.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, tag, notesFile, out] = process.argv.slice(2);
if (!dir || !tag || !notesFile || !out) {
  console.error("usage: update-manifest.mjs <assets-dir> <tag> <notes-file> <out-file>");
  process.exit(2);
}

const REPO = "spec-0/studio";
const version = tag.replace(/^v/, "");

/** Stable file name → the updater keys it serves. */
const FILES = {
  "spec0-studio-macos-universal.app.tar.gz": [
    "darwin-universal",
    "darwin-aarch64",
    "darwin-x86_64",
    "darwin-aarch64-app",
    "darwin-x86_64-app",
  ],
  "spec0-studio-linux-x86_64.AppImage": ["linux-x86_64", "linux-x86_64-appimage"],
  "spec0-studio-linux-amd64.deb": ["linux-x86_64-deb"],
  "spec0-studio-windows-x64-setup.exe": ["windows-x86_64", "windows-x86_64-nsis"],
};

const platforms = {};
const missing = [];
for (const [file, keys] of Object.entries(FILES)) {
  const sig = join(dir, `${file}.sig`);
  if (!existsSync(join(dir, file)) || !existsSync(sig)) {
    missing.push(file);
    continue;
  }
  const entry = {
    signature: readFileSync(sig, "utf8").trim(),
    url: `https://github.com/${REPO}/releases/download/${tag}/${file}`,
  };
  for (const key of keys) platforms[key] = entry;
}

if (missing.length) {
  console.error(`Missing a file or its signature: ${missing.join(", ")}`);
  process.exit(1);
}

const manifest = {
  version,
  notes: readFileSync(notesFile, "utf8").trim(),
  pub_date: new Date().toISOString(),
  platforms,
};
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${out} for ${version}: ${Object.keys(platforms).join(", ")}`);
