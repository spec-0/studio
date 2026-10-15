import { fileURLToPath } from 'node:url';
import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

// The pages are in ../docs/user, outside this folder, so the bundler's root is
// the repository rather than site/.
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// GitHub Pages serves the site at https://spec-0.github.io/studio, so pages and
// files live under /studio. A custom domain serves it at the root: build with
// SITE_BASE_PATH="" and SITE_URL set to that domain.
const basePath = (process.env.SITE_BASE_PATH ?? '/studio').replace(/\/$/, '');
const siteUrl = process.env.SITE_URL ?? `https://spec-0.github.io${basePath}`;

/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  reactStrictMode: true,
  basePath,
  // /library → /library/index.html, which every static host serves as /library/.
  trailingSlash: true,
  images: { unoptimized: true },
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
    NEXT_PUBLIC_SITE_URL: siteUrl,
  },
};

export default withMDX(config);
