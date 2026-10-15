// Checks the user guide in docs/user before the site in site/ builds it.
//
// It catches what would break the site: frontmatter it can't read, components
// it doesn't have, links between pages that lead nowhere, and images that
// aren't here. No dependencies, so it runs in a second, without building the
// site. (The site build checks its own output too.)
//
//   node scripts/check-user-docs.mjs

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = new URL("../docs/user/", import.meta.url).pathname;
const ASSETS = join(ROOT, "assets");

/** Components the site provides, and the props each one must have. */
const COMPONENTS = {
  Callout: [],
  Tabs: [],
  Tab: [],
  Steps: [],
  Step: [],
  Accordions: [],
  Accordion: [],
  Screenshot: ["src", "alt", "caption", "width", "height"],
  Clip: ["src", "poster", "label", "caption", "width", "height"],
};
const FRONTMATTER_KEYS = new Set(["title", "description", "docType", "icon", "full"]);
const DOC_TYPES = new Set(["how-to", "concept", "reference", "recipe"]);

const errors = [];
const fail = (file, line, message) => errors.push(`${file}${line ? `:${line}` : ""}: ${message}`);

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const rel = (path) => relative(ROOT, path).split(sep).join("/");
const all = walk(ROOT);
const pages = all.filter((path) => path.endsWith(".mdx"));
const assets = all.filter((path) => path.startsWith(ASSETS + sep)).map((path) => "/" + rel(path).slice("assets/".length));
const usedAssets = new Set();

/**
 * Replaces code (fenced blocks and inline spans) with spaces, keeping line
 * numbers, so examples of syntax aren't checked as if they were real.
 */
function withoutCode(text) {
  let inFence = null;
  return text
    .split("\n")
    .map((line) => {
      const fence = line.match(/^\s*(```+|~~~+)/);
      if (fence) {
        if (!inFence) inFence = fence[1][0];
        else if (fence[1][0] === inFence) inFence = null;
        return "";
      }
      if (inFence) return "";
      return line.replace(/`+[^`]*`+/g, (span) => " ".repeat(span.length));
    })
    .join("\n");
}

/** The id the site gives a heading (GitHub's rules: lower case, punctuation dropped, spaces to dashes). */
function slug(heading) {
  const custom = heading.match(/\[#([^\]]+)\]\s*$/);
  if (custom) return custom[1];
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** Heading ids for each page, keyed by its path relative to docs/user. */
const anchors = new Map();
for (const path of pages) {
  const seen = new Map();
  const ids = new Set();
  for (const line of withoutCode(readFileSync(path, "utf8")).split("\n")) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!heading) continue;
    const base = slug(heading[1]);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    ids.add(count ? `${base}-${count}` : base);
  }
  anchors.set(rel(path), ids);
}

/** The page file a site path (such as /collections/running) points at, or null. */
function pageFor(sitePath) {
  const rest = sitePath.replace(/^\/|\/$/g, "");
  const candidates = rest ? [`${rest}.mdx`, `${rest}/index.mdx`] : ["index.mdx"];
  return candidates.find((candidate) => anchors.has(candidate)) ?? null;
}

function checkLink(file, line, target) {
  if (/^(https?:|mailto:)/.test(target)) return;
  const [path, hash] = target.split("#");
  if (!path) {
    if (!anchors.get(file).has(hash)) fail(file, line, `no heading with the id #${hash} on this page`);
    return;
  }
  if (!path.startsWith("/")) {
    fail(file, line, `link to ${target}: use a site path such as /library, not a relative path`);
    return;
  }
  const page = pageFor(path);
  if (!page) {
    fail(file, line, `link to ${target}: there's no page at ${path}`);
    return;
  }
  if (hash && !anchors.get(page).has(hash)) fail(file, line, `link to ${target}: ${page} has no heading with the id #${hash}`);
}

function checkAsset(file, line, src) {
  if (!src.startsWith("/")) {
    fail(file, line, `${src}: images and clips go in docs/user/assets and are referenced from the site root, e.g. /images/product/studio-console.webp`);
    return;
  }
  usedAssets.add(src);
  if (!existsSync(join(ASSETS, src))) fail(file, line, `${src}: no such file in docs/user/assets${src}`);
}

function checkFrontmatter(file, text) {
  const lines = text.split("\n");
  if (lines[0] !== "---") return fail(file, 1, "the page must start with frontmatter (---)");
  const end = lines.indexOf("---", 1);
  if (end < 0) return fail(file, 1, "the frontmatter isn't closed with ---");
  const fields = {};
  for (let i = 1; i < end; i++) {
    const field = lines[i].match(/^([A-Za-z]+):\s*(.*)$/);
    if (!field) {
      fail(file, i + 1, `can't read this frontmatter line: ${lines[i]}`);
      continue;
    }
    const [, key, raw] = field;
    if (!FRONTMATTER_KEYS.has(key)) fail(file, i + 1, `unknown frontmatter field "${key}"`);
    fields[key] = raw.replace(/^(["'])(.*)\1$/, "$2").trim();
  }
  if (!fields.title) fail(file, 1, "the frontmatter needs a title");
  if (!fields.description) fail(file, 1, "the frontmatter needs a description");
  if (!DOC_TYPES.has(fields.docType)) fail(file, 1, `docType must be one of: ${[...DOC_TYPES].join(", ")}`);
  return end + 1;
}

for (const path of pages) {
  const file = rel(path);
  const text = readFileSync(path, "utf8");
  checkFrontmatter(file, text);
  const body = withoutCode(text);
  const lines = body.split("\n");

  lines.forEach((line, index) => {
    const n = index + 1;
    if (/^(import\s.+\sfrom\s|import\s+["']|export\s+(const|let|default|function)\b)/.test(line)) fail(file, n, "imports and exports aren't allowed; use the components the site provides");
    for (const [, name] of line.matchAll(/<([A-Z][A-Za-z0-9.]*)/g)) {
      if (!(name in COMPONENTS)) fail(file, n, `<${name}> isn't available on the site. Use one of: ${Object.keys(COMPONENTS).join(", ")}`);
    }
    for (const [, target] of line.matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) checkLink(file, n, target);
    for (const [, target] of line.matchAll(/\bhref="([^"]+)"/g)) checkLink(file, n, target);
    for (const [, src] of line.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)) checkAsset(file, n, src);
    for (const [, src] of line.matchAll(/\b(?:src|poster)="([^"]+)"/g)) checkAsset(file, n, src);
  });

  // Required props, read across lines from each tag's opening to its end.
  for (const [name, required] of Object.entries(COMPONENTS)) {
    if (!required.length) continue;
    for (const match of body.matchAll(new RegExp(`<${name}\\b([\\s\\S]*?)/?>`, "g"))) {
      const props = new Set([...match[1].matchAll(/([A-Za-z]+)=/g)].map((m) => m[1]));
      const missing = required.filter((prop) => !props.has(prop));
      const n = body.slice(0, match.index).split("\n").length;
      if (missing.length) fail(file, n, `<${name}> needs ${missing.join(", ")}`);
    }
  }
}

// Navigation: every meta.json lists pages that exist, and every page is listed.
for (const path of all.filter((p) => p.endsWith("meta.json"))) {
  const file = rel(path);
  const dir = path.slice(0, -"meta.json".length);
  let meta;
  try {
    meta = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(file, 0, `not valid JSON: ${error.message}`);
    continue;
  }
  if (!Array.isArray(meta.pages)) {
    fail(file, 0, 'needs a "pages" list');
    continue;
  }
  const listed = new Set();
  for (const entry of meta.pages) {
    if (/^---.*---$/.test(entry)) continue; // a section heading
    listed.add(entry);
    if (!existsSync(join(dir, `${entry}.mdx`)) && !existsSync(join(dir, entry, "index.mdx"))) {
      fail(file, 0, `"${entry}" is listed but there's no ${entry}.mdx or ${entry}/index.mdx`);
    }
  }
  for (const name of readdirSync(dir)) {
    const entry = name.endsWith(".mdx") ? name.slice(0, -4) : statSync(join(dir, name)).isDirectory() && name !== "assets" ? name : null;
    if (!entry || entry === "index") continue;
    if (!listed.has(entry)) fail(file, 0, `"${entry}" isn't listed in "pages", so it wouldn't appear in the navigation`);
  }
}

for (const asset of assets) {
  if (!usedAssets.has(asset)) fail(`assets${asset}`, 0, "no page uses this file; remove it or reference it");
}

if (errors.length) {
  console.error(errors.join("\n"));
  console.error(`\n${errors.length} problem${errors.length === 1 ? "" : "s"} in docs/user.`);
  process.exit(1);
}
console.log(`docs/user: ${pages.length} pages and ${assets.length} images and clips look right.`);
