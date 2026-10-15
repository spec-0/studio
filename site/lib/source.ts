import { llms, loader } from 'fumadocs-core/source';
import { defineDocs } from 'fumadocs-mdx/macro';
import { metaSchema, pageSchema } from 'fumadocs-core/source/schema';
import { siteUrl } from './shared';

// The pages live in docs/user at the root of the repository, next to the app
// they describe. The site reads them from there; nothing is copied.
// (Their `docType` field is checked by scripts/check-user-docs.mjs.)
const docs = defineDocs({
  dir: '../docs/user',
  docs: {
    // Only the pages: docs/user/README.md is for people editing them.
    files: ['**/*.mdx'],
    schema: pageSchema,
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
  meta: {
    schema: metaSchema,
  },
});

export const source = loader({
  baseUrl: '/',
  source: docs.toFumadocsSource(),
  plugins: [],
});

/**
 * Links between pages are written from the site root (/local-mocks). Agents
 * read llms.txt and the markdown copies on their own, away from the site, so
 * those links get the full address.
 */
export function absoluteLinks(markdown: string): string {
  return markdown.replace(/\]\(\//g, `](${siteUrl}/`);
}

const base = llms(source, {
  renderPage: async (page) => `# ${page.data.title} (${siteUrl}${page.url})

${await page.data.getText('processed')}`,
});

export const docsLlms = {
  index: async () => absoluteLinks(await base.index()),
  full: async () => absoluteLinks(await base.full()),
  page: async (page: Parameters<typeof base.page>[0]) => absoluteLinks(await base.page(page)),
};
