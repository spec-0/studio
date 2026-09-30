/**
 * The rendered API reference, using the same renderer as `app.spec0.io`.
 *
 * Loaded through `React.lazy` from {@link DocumentView} and nowhere else: this
 * module pulls in Scalar, which is by a wide margin the largest thing Studio
 * depends on. Keeping it behind a dynamic import means opening a spec, browsing
 * operations and firing a request (everything the app is actually for) never
 * pay for a renderer the session may not open.
 *
 * The web dashboard and the public registry each keep their own copy of this
 * wrapper with their own theme; the divergence is deliberate rather than drift,
 * so this is a third sibling rather than a shared package flattening three
 * visual identities into one.
 *
 * **Scalar's request client is off, permanently.** It is a good feature in a
 * browser and the wrong one here, for two independent reasons: it would fire
 * from the webview and so would carry an `Origin` header, which is exactly what
 * Studio's whole HTTP layer exists to avoid; and it would bypass environments,
 * auth schemes, per-host certificate trust and history: a second request path
 * with none of the properties that make the first one worth having. Requests go
 * through Studio. This tab reads.
 */

import { useMemo } from "react";
import { ApiReferenceReact, type ApiReferenceConfiguration } from "@scalar/api-reference-react";
import "@scalar/api-reference-react/style.css";

interface Props {
  /** The document as imported: the same text the Raw tab shows. */
  text: string;
  dark: boolean;
}

// Map Scalar onto Studio's tokens rather than restating any colour. The tokens
// in styles.css are the design system's; a hex here would be a second source of
// truth that drifts the first time the palette moves.
//
// The last rule hides Scalar's "Powered by Scalar" sidebar promo. No config
// flag exists, a maintainer sanctions removing it via CSS, and the package is
// MIT. Targeted by the stable scalar.com href rather than Scalar's
// churn-prone utility classes, and asserted by a test so a refactor can't drop
// it silently.
const BRAND_CSS = `
.light-mode, .dark-mode {
  --scalar-font: var(--font-sans);
  --scalar-font-code: var(--font-mono);
  --scalar-radius: var(--radius);
  --scalar-color-accent: hsl(var(--primary));
  --scalar-background-accent: hsl(var(--primary) / 0.08);
  --scalar-background-1: hsl(var(--bg));
  --scalar-background-2: hsl(var(--surface));
  --scalar-background-3: hsl(var(--surface-hover));
  --scalar-border-color: hsl(var(--border));
  --scalar-color-1: hsl(var(--ink));
  --scalar-color-2: hsl(var(--ink-2));
  --scalar-color-3: hsl(var(--ink-3));
  --scalar-color-green: hsl(var(--method-get));
  --scalar-color-orange: hsl(var(--method-post));
  --scalar-color-purple: hsl(var(--method-put));
  --scalar-color-red: hsl(var(--method-delete));
  --scalar-color-blue: hsl(var(--method-patch));
}
.scalar-app {
  background: transparent;
}
.scalar-app a[href*="scalar.com"] {
  display: none !important;
}
`;

export { BRAND_CSS };

/**
 * Nothing in this tab is allowed to reach the network.
 *
 * Out of the box Scalar calls `api.scalar.com` on mount: its Ask-AI agent
 * fetches `/vector/registry/curated`, and telemetry defaults to on. For a client whose entire subject matter is **internal, private** APIs,
 * quietly shipping a request to a third party the moment someone opens a spec is
 * not a defensible default, whoever the third party is.
 *
 * The flags below turn those off at the source. This function is the backstop,
 * and it is the part that actually holds: flags describe the features that exist
 * in the pinned version, and an upgrade that adds one more phone-home would sail
 * past a list of flags. A renderer handed the whole document has no legitimate
 * reason to fetch anything, so the honest configuration is "no network at all",
 * and rejecting reads to Scalar as ordinary offline, which is a state it
 * already knows how to render.
 */
const refuseNetwork = (async (input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  throw new Error(`the reference renderer may not make network requests (blocked: ${url})`);
}) as typeof fetch;

export default function ScalarReference({ text, dark }: Props) {
  const configuration = useMemo<Partial<ApiReferenceConfiguration>>(
    () => ({
      // The document text, not a URL: the Reference tab renders what the
      // library holds so it works offline and can never disagree with Raw.
      content: text,
      theme: "default",
      layout: "modern",
      forceDarkModeState: dark ? "dark" : "light",
      hideDarkModeToggle: true,
      hideTestRequestButton: true,
      // Scalar's search is a registry search against api.scalar.com, not a
      // search of this document. The sidebar already filters what's here.
      hideSearch: true,
      // Scalar's own product toolbar (Configure / Share / Deploy). It defaults
      // to showing on localhost, and a Tauri webview *is* localhost, so this
      // would otherwise ship: another vendor's product surface inside ours,
      // offering actions Studio can't perform.
      showToolbar: "never",
      // Saving the document is Studio's job, through its own file IO and its own
      // save dialog. A second download path inside the renderer would sidestep
      // that, and the Raw tab is where the text already lives.
      documentDownloadType: "none",
      hideDownloadButton: true,
      // The Ask-AI agent; `telemetry` defaults to true and is the other caller.
      mcp: { disabled: true },
      telemetry: false,
      // Scalar otherwise pulls ~14 font files from fonts.scalar.com on mount.
      // Studio bundles Geist and JetBrains Mono locally and the brand CSS above
      // points Scalar at them, so the remote faces are both unnecessary and a
      // request to a third party made because someone opened a document.
      withDefaultFonts: false,
      fetch: refuseNetwork,
      customFetch: refuseNetwork,
      customCss: BRAND_CSS,
    }),
    [text, dark],
  );

  // Keyed on the theme because Scalar reads `forceDarkModeState` at mount only;
  // without this a ⌘D leaves a light reference inside a dark shell.
  return <ApiReferenceReact key={dark ? "dark" : "light"} configuration={configuration} />;
}
