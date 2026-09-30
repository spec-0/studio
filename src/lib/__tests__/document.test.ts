/**
 * Guard tests for the document view.
 *
 * These read source rather than render it. Both rules they protect are
 * structural ("this view never calls the platform" and "the renderer is handed
 * text, not a URL"), and a rendering test would assert on the absence of a
 * network call, which passes just as happily when the code has been rewritten
 * to make one lazily. Reading the import graph is the thing that actually fails
 * when the rule breaks.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const source = (file: string) => readFileSync(resolve(here, "../../components", file), "utf8");

const DOCUMENT = source("DocumentView.tsx");
const SCALAR = source("ScalarReference.tsx");

describe("the free tier", () => {
  // Rule 1 of the app: reading a spec needs no account and no network call to
  // spec0. The document view is the newest place that could quietly break it.
  it("imports nothing from the platform client at runtime", () => {
    // No `s` flag: `.` must not cross newlines, or one match swallows every
    // import above it and the assertion stops describing a single statement.
    const imports = DOCUMENT.match(/^import .*from "\.\.\/lib\/spec0";$/gm) ?? [];
    expect(imports.length, "expected the view to reference the client's types").toBeGreaterThan(0);
    for (const line of imports) {
      // `import type { … }` only. A mixed `import { fn, type T }` brings a
      // runtime binding along and is exactly the shape that would slip past a
      // looser check.
      expect(line, `${line} must be a type-only import`).toMatch(/^import type \{/);
    }
    expect(SCALAR).not.toContain("lib/spec0");
  });

  it("never calls a platform function from either component", () => {
    for (const [name, text] of [
      ["DocumentView", DOCUMENT],
      ["ScalarReference", SCALAR],
    ] as const) {
      expect(text, `${name} must not fetch`).not.toMatch(/\bfetch\(|appFetch|getApiConsumers\(/);
    }
  });
});

describe("the renderer", () => {
  // If Scalar were handed a URL it would fetch the document itself: offline
  // would break, and Raw and Reference could disagree about what the spec says.
  it("is handed the document text, not somewhere to fetch it from", () => {
    expect(SCALAR).toMatch(/content:\s*text/);
    expect(SCALAR).not.toMatch(/url:\s*/);
  });

  // Scalar's request client would go out from the webview with an Origin
  // header (the one thing Studio's HTTP layer exists to avoid) and would bypass environments, auth, certificate trust and history.
  it("keeps Scalar's own request client switched off", () => {
    expect(SCALAR).toMatch(/hideTestRequestButton:\s*true/);
  });

  // Scalar calls api.scalar.com on mount: its Ask-AI agent from module scope,
  // plus telemetry, which defaults to on. Studio's subject matter is private
  // APIs, so opening a spec must not produce a third-party request. The flags are half of the fix; the build-time
  // stub is the half that survives an upgrade.
  it("switches off every path that reaches Scalar's servers", () => {
    expect(SCALAR).toMatch(/telemetry:\s*false/);
    expect(SCALAR).toMatch(/mcp:\s*\{\s*disabled:\s*true\s*\}/);
    expect(SCALAR).toMatch(/hideSearch:\s*true/);
    expect(SCALAR).toMatch(/fetch:\s*refuseNetwork/);
    expect(SCALAR).toMatch(/customFetch:\s*refuseNetwork/);
  });

  it("does not ship the agent-chat module at all", () => {
    // Configuration can't stop it: the request goes out when the chunk
    // loads. So the module is aliased away in vite.config.ts and the alias is
    // load-bearing, not an optimisation.
    const vite = readFileSync(resolve(here, "../../../vite.config.ts"), "utf8");
    expect(vite).toContain("@scalar\\/agent-chat");
    expect(vite).toContain("scalar-agent-chat-stub");
  });

  it("does not let Scalar fetch its own fonts", () => {
    // Scalar loads its fonts from fonts.scalar.com on mount. Studio bundles
    // Geist and JetBrains Mono, so the remote faces would be a third-party
    // request made because someone opened a document.
    expect(SCALAR).toMatch(/withDefaultFonts:\s*false/);
  });

  it("keeps the sidebar promo rule the licence review depends on", () => {
    expect(SCALAR).toContain('a[href*="scalar.com"]');
    expect(SCALAR).toContain("display: none !important");
  });

  // The tokens in styles.css are the design system's. A hex here would be a
  // second source of truth that drifts the first time the palette moves.
  it("themes from tokens rather than restating any colour", () => {
    const css = SCALAR.slice(SCALAR.indexOf("BRAND_CSS"), SCALAR.indexOf("export {"));
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).toContain("hsl(var(--primary))");
  });

  it("is loaded lazily, so a session that never opens it pays nothing", () => {
    expect(DOCUMENT).toMatch(/lazy\(\(\) => import\("\.\/ScalarReference"\)\)/);
  });
});

describe("the tabs", () => {
  it("are named to match the dashboard", () => {
    expect(DOCUMENT).toMatch(/>\s*Raw\s*</);
    expect(DOCUMENT).toMatch(/>\s*Reference\s*</);
  });
});

describe("the webview's content security policy", () => {
  // A spec's markdown can reference a remote image, and rendering it tells the
  // spec's author who opened their document, from where, and when. For a client
  // whose subject is private APIs that is a disclosure, not a nicety. The
  // policy is the defence that holds regardless of what the renderer decides to
  // do next, which a list of vendor flags does not.
  const conf = JSON.parse(readFileSync(resolve(here, "../../../src-tauri/tauri.conf.json"), "utf8"));
  const csp: string = conf.app?.security?.csp ?? "";

  it("exists at all", () => {
    expect(csp, "tauri.conf.json must set app.security.csp").toBeTruthy();
  });

  it.each([
    ["default-src 'self'", "nothing loads from anywhere else by default"],
    ["img-src 'self' data: blob:", "a spec cannot beacon through an image"],
    ["font-src 'self' data:", "fonts are bundled; no remote face is legitimate"],
    ["script-src 'self'", "no injected script from document content"],
    ["object-src 'none'", ""],
    ["frame-src 'none'", ""],
    ["form-action 'none'", ""],
  ])("carries %s", (directive) => {
    expect(csp).toContain(directive);
  });

  it("still lets the app talk to its own Rust side", () => {
    // Outbound HTTP is Rust's job; the webview needs only the IPC endpoints.
    expect(csp).toContain("connect-src 'self' ipc: http://ipc.localhost");
  });

  it("allows no remote origin anywhere in the policy", () => {
    const remote = csp.match(/https?:\/\/(?!ipc\.localhost)[^\s;]+/g) ?? [];
    expect(remote, `policy names remote origins: ${remote.join(", ")}`).toEqual([]);
  });
});
