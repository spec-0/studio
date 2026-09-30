/**
 * Drive the document view in headless Chrome.
 *
 * Separate from capture.mjs because the thing worth proving here is narrow and
 * not obvious from a type-check: that Scalar actually mounts inside a plain Vite
 * bundle, renders the spec it was handed, and does it without throwing. A build
 * that compiles and a renderer that runs are different claims.
 *
 *   node scripts/capture-document.mjs <out-dir>
 */
import puppeteer from "puppeteer-core";

const CHROME =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const URL = process.env.STUDIO_URL ?? "http://localhost:5175";
const outDir = process.argv[2] ?? ".";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--force-device-scale-factor=2", "--hide-scrollbars"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
// A request to spec0 from this journey would break the free-tier rule outright.
const outbound = [];
page.on("request", (r) => {
  const url = r.url();
  if (!url.startsWith(URL) && !url.startsWith("data:") && !url.startsWith("blob:")) {
    outbound.push(url);
  }
});

await page.goto(URL, { waitUntil: "networkidle0" });
await page.evaluate(() => window.localStorage.clear());
await page.reload({ waitUntil: "networkidle0" });
await wait(500);

const clickByText = (selector, text) =>
  page.evaluate(
    (sel, needle) => {
      const el = [...document.querySelectorAll(sel)].find((n) => n.textContent?.includes(needle));
      if (el) el.click();
      return Boolean(el);
    },
    selector,
    text,
  );
const clickLabel = (label) =>
  page.evaluate((l) => {
    const el = document.querySelector(`[aria-label="${l}"]`);
    if (el) el.click();
    return Boolean(el);
  }, label);

if (!(await clickByText(".btn", "Try a sample API"))) throw new Error("no sample button");
await page.waitForSelector(".sidebar", { timeout: 15000 });
await wait(700);

if (!(await clickLabel("The document"))) throw new Error("no document button");
await page.waitForSelector(".doc", { timeout: 15000 });

// Reference is the default tab; Scalar is lazy, so give the chunk time to land.
await page.waitForSelector(".scalar-app, .doc-reference", { timeout: 25000 });
await wait(3500);
await page.screenshot({ path: `${outDir}/doc-reference.png` });

const rendered = await page.evaluate(() => {
  const root = document.querySelector(".doc-reference");
  return {
    scalarMounted: Boolean(document.querySelector(".scalar-app")),
    text: (root?.innerText ?? "").slice(0, 400),
    nodes: root?.querySelectorAll("*").length ?? 0,
  };
});

await clickByText(".doc-tabs button", "Raw");
await page.waitForSelector(".doc-raw", { timeout: 10000 });
await wait(600);
await page.screenshot({ path: `${outDir}/doc-raw.png` });

const raw = await page.evaluate(() => ({
  lines: document.querySelectorAll(".doc-line").length,
  gutterFirst: document.querySelector(".doc-gutter")?.textContent,
  kinds: [...new Set([...document.querySelectorAll('[class^="tk-"]')].map((n) => n.className))],
  bar: document.querySelector(".doc-raw-bar .meta")?.textContent,
}));

await browser.close();

console.log("scalar mounted:      ", rendered.scalarMounted);
console.log("reference nodes:     ", rendered.nodes);
console.log("reference text head: ", JSON.stringify(rendered.text.replace(/\s+/g, " ").slice(0, 220)));
console.log("raw lines rendered:  ", raw.lines, "(windowed, not the whole document)");
console.log("raw gutter starts at:", raw.gutterFirst);
console.log("raw bar:             ", raw.bar);
console.log("token kinds present: ", raw.kinds.join(", "));
console.log("outbound requests:   ", outbound.length ? outbound.join("\n  ") : "none");
console.log("page errors:         ", errors.length ? errors.join("\n  ") : "none");

if (errors.length) process.exit(1);
if (!rendered.scalarMounted) process.exit(2);
