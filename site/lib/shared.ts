import { createGetUrl } from 'fumadocs-core/source';

/**
 * Where the site is served. GitHub Pages serves this repository's site under
 * /studio; a custom domain would serve it at the root. Both come from the build
 * environment (see next.config.mjs), so links and files follow either one.
 */
export const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
export const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL ?? '').replace(/\/$/, '');

export const appName = 'Spec0 Studio';
export const docsContentRoute = '/llms.mdx';

export const gitConfig = {
  user: 'spec-0',
  repo: 'studio',
  branch: 'main',
};

export const repoUrl = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;
export const downloadUrl = `${repoUrl}/releases/latest`;
export const spec0Url = 'https://spec0.io';

/** The page's source file on GitHub, for "Edit on GitHub". */
export function editUrl(path: string): string {
  return `${repoUrl}/blob/${gitConfig.branch}/docs/user/${path}`;
}

/** A path inside the site with the base path in front, for plain <img>, <video> and fetch. */
export function withBase(path: string): string {
  return path.startsWith('/') ? `${basePath}${path}` : path;
}

const getContentUrl = createGetUrl(docsContentRoute);

/** Where a page's markdown copy is published, for coding agents and "Copy page". */
export function getPageMarkdownUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, 'content.md'];

  return { segments, url: getContentUrl(segments, page.locale) };
}
