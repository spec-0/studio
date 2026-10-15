import { fileURLToPath } from 'node:url';
import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

// The pages are in ../docs/user, outside this folder, so the bundler's root is
// the repository rather than site/.
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// The site is served at the root of its own domain, https://studio-docs.spec0.io.
// To serve it under a path instead (for example GitHub's own
// https://spec-0.github.io/studio), build with SITE_BASE_PATH=/studio and
// SITE_URL set to the full address.
const basePath = (process.env.SITE_BASE_PATH ?? '').replace(/\/$/, '');
const siteUrl = (process.env.SITE_URL ?? 'https://studio-docs.spec0.io').replace(/\/$/, '');

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
