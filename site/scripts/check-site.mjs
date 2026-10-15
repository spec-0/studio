// Checks the built site in out/ after `next build`: every link, image and clip
// that points inside the site must lead to a file that was built. Fails the
// build otherwise, so a broken link never reaches the published site.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../out', import.meta.url));
const basePath = (process.env.SITE_BASE_PATH ?? '').replace(/\/$/, '');

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** The built file a site URL is served from, or null. */
function fileFor(url) {
  let path = decodeURIComponent(url.split(/[?#]/)[0]);
  if (basePath) {
    if (path !== basePath && !path.startsWith(`${basePath}/`)) return null;
    path = path.slice(basePath.length) || '/';
  }
  const candidates = path.endsWith('/') ? [`${path}index.html`] : [path, `${path}.html`, `${path}/index.html`];
  return candidates.map((candidate) => join(out, candidate)).find((file) => existsSync(file) && statSync(file).isFile()) ?? null;
}

const pages = walk(out).filter((file) => file.endsWith('.html'));
const problems = [];
let checked = 0;
for (const file of pages) {
  const html = readFileSync(file, 'utf8');
  for (const [, attr, url] of html.matchAll(/\s(href|src|poster)="([^"]+)"/g)) {
    if (!url.startsWith('/') || url.startsWith('//')) continue;
    if (url.startsWith(`${basePath}/_next/`)) continue; // Next's own bundles
    checked++;
    if (!fileFor(url)) problems.push(`${file.slice(out.length)}: ${attr}="${url}" leads nowhere`);
  }
}

if (problems.length) {
  console.error([...new Set(problems)].join('\n'));
  console.error(`\n${problems.length} broken link${problems.length === 1 ? '' : 's'} in the built site.`);
  process.exit(1);
}
console.log(`site: ${pages.length} pages built, ${checked} links, images and clips inside the site all resolve.`);
