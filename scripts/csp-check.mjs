/**
 * Run the app under its real content security policy and fail on any violation.
 *
 * Unit tests run in Node, which has no CSP, so code the policy blocks (for
 * example a validator built with `new Function` under `script-src 'self'`)
 * passes every test and fails in the app. This runs the built code in a
 * browser under the actual policy. It reads the policy out of
 * `tauri.conf.json` rather than restating it, so relaxing the policy cannot
 * quietly relax the test with it.
 *
 * Two checks:
 *   1. The bundled app loads with no CSP violation. This is the general guard
 *      against any dependency that starts needing eval.
 *   2. Response validation actually produces findings. The app can load fine
 *      while validation alone is blocked.
 *
 *   node scripts/csp-check.mjs
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import puppeteer from "puppeteer-core";

const ROOT = resolve(import.meta.dirname, "..");
const DIST = join(ROOT, "dist");
const PORT = Number(process.env.CSP_CHECK_PORT ?? 5411);

const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
};

const fail = (message) => {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
};

if (!existsSync(DIST)) fail("dist/ not found. Run `npm run build` first.");
if (!existsSync(CHROME)) fail(`Chrome not found at ${CHROME}. Set CHROME_PATH.`);

// The policy under test is the one the app ships with, read from source.
const conf = JSON.parse(await readFile(join(ROOT, "src-tauri/tauri.conf.json"), "utf8"));
const csp = conf.app?.security?.csp;
if (!csp) fail("tauri.conf.json declares no app.security.csp, so there is nothing to test against.");

// A fixture that drives validation directly. The app cannot send a request
// without the Rust side, so the check that matters is exercised on its own.
const FIXTURE = "__csp-check-fixture.js";
execFileSync(
  "npx",
  [
    "esbuild",
    join(ROOT, "scripts/csp-fixture.ts"),
    "--bundle",
    "--format=esm",
    `--outfile=${join(DIST, FIXTURE)}`,
  ],
  { cwd: ROOT, stdio: "pipe" },
);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const file =
    url.pathname === "/fixture"
      ? join(DIST, "__fixture.html")
      : join(DIST, url.pathname === "/" ? "index.html" : url.pathname.slice(1));
  try {
    const body =
      url.pathname === "/fixture"
        ? Buffer.from(
            `<!doctype html><meta charset="utf-8"><script type="module" src="/${FIXTURE}"></script>`,
          )
        : await readFile(file);
    res.writeHead(200, {
      "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
      // The whole point: serve exactly what the webview enforces.
      "Content-Security-Policy": csp,
    });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(PORT, "127.0.0.1", done));

// GitHub's Linux runners ship Chrome without a correctly-owned SUID sandbox
// helper, and Chrome aborts rather than run unsandboxed. The sandbox is process
// isolation and unrelated to the policy under test, so it is dropped on CI
// only; it stays on on a developer's machine.
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: process.env.CI ? ["--no-sandbox", "--disable-setuid-sandbox"] : [],
});
let failures = 0;

const openPage = async () => {
  const page = await browser.newPage();
  const violations = [];

  // `securitypolicyviolation` is the reliable signal. Console capture is not:
  // a violation the page swallows in a try/catch (validation catches its own
  // EvalError and reports it as a note) never surfaces there. Registered
  // through CDP so the listener itself is not subject to the policy it is
  // watching.
  await page.evaluateOnNewDocument(() => {
    globalThis.__CSP_VIOLATIONS__ = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      globalThis.__CSP_VIOLATIONS__.push(
        `${event.violatedDirective} blocked ${event.blockedURI || "inline/eval"}`,
      );
    });
  });

  page.on("pageerror", (e) => {
    if (/Content Security Policy|unsafe-eval|EvalError/i.test(String(e))) violations.push(String(e));
  });

  const collect = async () => {
    const fromPage = await page.evaluate(() => globalThis.__CSP_VIOLATIONS__ ?? []);
    return [...violations, ...fromPage];
  };
  return { page, collect };
};

// 1. The app itself loads clean
{
  const { page, collect } = await openPage();
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle0" });
  const violations = await collect();
  if (violations.length) {
    failures += 1;
    console.error("✗ the app violates its own content security policy on load:");
    for (const v of violations) console.error(`    ${v.slice(0, 200)}`);
  } else {
    console.log("✓ app loads with no CSP violation");
  }
  await page.close();
}

// 2. Response validation still works under it
{
  const { page, collect } = await openPage();
  await page.goto(`http://127.0.0.1:${PORT}/fixture`, { waitUntil: "networkidle0" });
  const results = await page.evaluate(() => globalThis.__CSP_CHECK__ ?? null);
  const violations = await collect();

  if (violations.length) {
    failures += 1;
    console.error("✗ validating a response violates the content security policy:");
    for (const v of violations) console.error(`    ${v.slice(0, 200)}`);
  }
  if (!results) {
    failures += 1;
    console.error("✗ the fixture produced no result at all. It threw before reporting.");
  } else {
    // `status: "error"` means validation ran, failed to construct a validator,
    // and reported its own failure as a note.
    if (results.valid?.status !== "ok") {
      failures += 1;
      console.error(
        `✗ a conforming response was not reported as ok (got ${results.valid?.status}: ${results.valid?.note ?? ""})`,
      );
    }
    if (results.invalid?.status !== "mismatch") {
      failures += 1;
      console.error(
        `✗ a non-conforming response was not reported as a mismatch (got ${results.invalid?.status}: ${results.invalid?.note ?? ""})`,
      );
    }
    const kinds = new Set((results.invalid?.findings ?? []).map((f) => f.kind));
    for (const expected of ["missing_required", "type_mismatch", "extra_field"]) {
      if (!kinds.has(expected)) {
        failures += 1;
        console.error(`✗ expected a ${expected} finding and got none`);
      }
    }
    if (!failures) console.log("✓ response validation runs and reports findings under the policy");

    const swagger = results.swagger2 ?? {};
    const swaggerOk =
      swagger.converted === "Swagger 2.0" &&
      swagger.operations === 1 &&
      swagger.text === true &&
      swagger.validation === "mismatch";
    if (swaggerOk) console.log("✓ a Swagger 2.0 spec converts and its responses are checked under the policy");
    else {
      failures += 1;
      console.error(`✗ opening a Swagger 2.0 spec failed under the policy: ${JSON.stringify(swagger).slice(0, 300)}`);
    }
  }
  await page.close();
}

await browser.close();
server.close();

if (failures) {
  console.error(`\n${failures} check(s) failed under the app's content security policy.\n`);
  process.exit(1);
}
console.log("\nAll CSP checks passed.\n");
