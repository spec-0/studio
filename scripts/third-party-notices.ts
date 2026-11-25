/**
 * Third-party notices for the packages bundled into the app.
 *
 * The licences of most of what Studio bundles (MIT, BSD, ISC, Apache-2.0, and
 * EPL-2.0 for the schema graph's layout engine) ask that their notice travel with
 * the software. This collects them at build time from the modules that actually
 * ended up in the bundle, not from package.json, so a dependency that's installed
 * but tree-shaken away isn't listed and one that's bundled can't be missed. The
 * result is written next to the app as `third-party-notices.txt`, and Settings
 * shows it.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";

export const NOTICES_FILE = "third-party-notices.txt";

export interface BundledPackage {
  name: string;
  version: string;
  license: string;
  homepage?: string;
  /** The package's own licence or notice files, as written. */
  texts: string[];
}

/** The directory of the package a bundled module comes from, or undefined for the app's own code. */
export function packageDir(moduleId: string): string | undefined {
  const id = moduleId.replace(/^\0/, "").replace(/\?.*$/, "").replaceAll("\\", "/");
  const marker = "/node_modules/";
  const at = id.lastIndexOf(marker);
  if (at === -1) return undefined;
  const rest = id.slice(at + marker.length).split("/");
  const name = rest[0]?.startsWith("@") ? rest.slice(0, 2).join("/") : rest[0];
  return name ? id.slice(0, at + marker.length) + name : undefined;
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice)([._-].*)?$/i;

export function readPackage(dir: string): BundledPackage | undefined {
  const manifest = join(dir, "package.json");
  if (!existsSync(manifest)) return undefined;
  const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
    name?: string;
    version?: string;
    license?: string | { type?: string };
    licenses?: { type?: string }[];
    homepage?: string;
    repository?: string | { url?: string };
  };
  if (!pkg.name) return undefined;
  const license =
    typeof pkg.license === "string"
      ? pkg.license
      : (pkg.license?.type ?? pkg.licenses?.map((l) => l.type).join(" OR ") ?? "UNKNOWN");
  const repository = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  const texts = readdirSync(dir)
    .filter((file) => LICENSE_FILE.test(file))
    .sort()
    .map((file) => readFileSync(join(dir, file), "utf8").trim());
  return {
    name: pkg.name,
    version: pkg.version ?? "",
    license,
    homepage: pkg.homepage ?? repository?.replace(/^git\+/, "").replace(/\.git$/, ""),
    texts,
  };
}

const RULE = "-".repeat(78);

/** The notices file: a short list of every package first, then each one's licence text. */
export function renderNotices(packages: BundledPackage[]): string {
  const sorted = [...packages].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const lines = [
    "spec0 Studio includes the following open-source software.",
    "Each is listed with its licence, followed by the licence and notice texts it ships with.",
    "",
    ...sorted.map((p) => `${p.name} ${p.version}  (${p.license})`),
    "",
  ];
  for (const p of sorted) {
    lines.push(RULE, `${p.name} ${p.version}`, `Licence: ${p.license}`);
    if (p.homepage) lines.push(`Source: ${p.homepage}`);
    lines.push("");
    lines.push(p.texts.length ? p.texts.join("\n\n") : `This package ships no licence file. It is distributed under ${p.license}.`);
    lines.push("");
  }
  return lines.join("\n");
}

/** A Vite plugin that writes {@link NOTICES_FILE} for whatever the build bundled. */
export function thirdPartyNotices(): Plugin {
  return {
    name: "third-party-notices",
    apply: "build",
    generateBundle(_options, bundle) {
      const dirs = new Set<string>();
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        const ids = (output as { moduleIds?: string[] }).moduleIds ?? Object.keys(output.modules);
        for (const id of ids) {
          const dir = packageDir(id);
          if (dir) dirs.add(dir);
        }
      }
      const packages = new Map<string, BundledPackage>();
      for (const dir of dirs) {
        const pkg = readPackage(dir);
        // A package nested under another counts once per version.
        if (pkg) packages.set(`${pkg.name}@${pkg.version}`, pkg);
      }
      this.emitFile({ type: "asset", fileName: NOTICES_FILE, source: renderNotices([...packages.values()]) });
    },
  };
}
