// Copies the files the pages reference into public/, before the site builds.
//
// Pages reference images and clips from the site root, such as
// /images/product/studio-console.webp, and keep them in docs/user/assets. The
// Spec0 Studio logo comes from .github/assets. Both are copied rather than
// moved so the pages and the README keep a single copy in the repository.

import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const site = fileURLToPath(new URL('..', import.meta.url));
const repo = fileURLToPath(new URL('../..', import.meta.url));
const pub = `${site}public`;

rmSync(pub, { recursive: true, force: true });
mkdirSync(`${pub}/brand`, { recursive: true });
cpSync(`${repo}docs/user/assets`, pub, { recursive: true });
for (const name of ['spec0-studio-light.svg', 'spec0-studio-dark.svg']) {
  cpSync(`${repo}.github/assets/${name}`, `${pub}/brand/${name}`);
}
cpSync(`${repo}src-tauri/icons/128x128.png`, `${pub}/brand/icon.png`);
console.log('site: copied docs/user/assets and the logo into public/');
