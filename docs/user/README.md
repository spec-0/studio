# Studio user guide

These pages are the Studio user guide published at
[studio-docs.spec0.io](https://studio-docs.spec0.io/). This folder is
where they're written, so a fix or a new page starts here, as a pull request
like any other. The site itself is built from this folder by the app in
[`site/`](../../site/).

The site is published when a Studio release is, from that release's tag, so it
always describes the app people can download. A merged change shows up with
the next release. A maintainer can also publish a docs-only fix straight away
by running the **Publish docs** workflow.

## How the folder maps to the site

Each `.mdx` file is a page, at the same path on the site:

| File | Page |
|---|---|
| `index.mdx` | `/` |
| `local-mocks.mdx` | `/local-mocks/` |
| `collections/chaining.mdx` | `/collections/chaining/` |

`meta.json` in each folder sets the order of pages in the sidebar. Entries such
as `"---Mock servers---"` are section headings. A new page has to be added to
the `pages` list, or it won't appear in the navigation.

Images and clips live in `assets/`, laid out the way the site serves them:
`assets/images/product/studio-console.webp` is published as
`/images/product/studio-console.webp`, and that's the path a page uses.

## Writing a page

Pages are Markdown with a few components (MDX). Start with frontmatter:

```yaml
---
title: Local mock servers
description: Run a mock of any API in your library on this computer, with no account.
docType: how-to
---
```

`docType` says what kind of page it is. Use `how-to` for steps towards a goal,
`concept` for explaining one idea, `reference` for tables and lists of links,
and `recipe` for one small, complete task.

Link to other pages by their path on the site, such as
`[local mocks](/local-mocks)` or
`[the key](/hosted-mocks#regenerate-the-key)`, not by file name. The site adds
its own address in front. Links to anything else, including the rest of Spec0's
documentation at docs.spec0.io, use the full `https://` address.

These components are available. Anything else, and `import` or `export`
statements, won't work on the site.

- `<Callout>` for a note set apart from the text. It takes an optional `title`
  and `type` (`info`, `warn`, `error`, `success`).
- `<Steps>` with a `<Step>` for each numbered step.
- `<Tabs items={[...]}>` with a `<Tab value="...">` for each tab, for example
  setup for different clients.
- `<Accordions>` with `<Accordion title="...">` for detail most readers can skip.
- `<Screenshot>` for an image. It needs `src`, `alt`, `caption`, `width` and
  `height` (the image's size in pixels). `maxWidth` keeps a small capture from
  being stretched, and `minWidth` keeps a wide one readable on a phone.
- `<Clip>` for a short screen recording. It needs `src` (an `.mp4`), `poster`
  (a still shown before it plays), `label`, `caption`, `width` and `height`.

A caption says what the reader should notice, not what the heading above it
already said. Screenshots are WebP at twice the size they're shown; clips are
silent MP4s with a WebP poster next to them.

## Previewing your change

Run the site on your computer. It reads the pages from this folder and reloads
when you save one:

```bash
cd site
npm ci
npm run dev
```

Then open http://localhost:3000/.

Before you open a pull request, run the quick check from the root of the
repository:

```bash
npm run check:docs
```

It checks that:

- every page has a `title`, a `description` and a known `docType`
- only the components above are used, with the props they need
- links between pages, and their `#anchors`, lead somewhere
- every image or clip a page uses is in `assets/`, and every file in `assets/`
  is used
- every page is listed in a `meta.json`, and everything listed exists

On a pull request, CI runs the same check, builds the whole site (failing on
any link, image or clip that leads nowhere), and keeps the built site as an
artifact called **docs-site-preview**. Download it from the run's summary,
unzip it, run `npx serve` in that folder and open http://localhost:3000/
to see the site exactly as it will be published.

## Style

Write the way the rest of the guide is written: plainly, in the second person,
with the names of buttons and settings in **bold** as they appear in Studio.
Say what something does before how it works, keep claims to what Studio does
today, and mention limits where they matter rather than in a list at the end.
