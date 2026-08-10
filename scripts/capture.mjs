/**
 * Drive the real Studio UI in headless Chrome and capture the user journey:
 * empty library → sample API → back → second API → switcher → operation.
 *
 *   node scripts/capture.mjs <spec-file> <out-dir>
 */
import puppeteer from "puppeteer-core";

const CHROME =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const URL = process.env.STUDIO_URL ?? "http://localhost:5174";
const [specPath, outDir] = process.argv.slice(2);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--force-device-scale-factor=2", "--hide-scrollbars"],
});

const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });

const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});

// Start from a clean library so the run is reproducible.
await page.goto(URL, { waitUntil: "networkidle0" });
await page.evaluate(() => window.localStorage.clear());
await page.reload({ waitUntil: "networkidle0" });
await wait(500);

const clickByText = (selector, text) =>
  page.evaluate(
    (sel, needle) => {
      const target = [...document.querySelectorAll(sel)].find((el) =>
        el.textContent?.includes(needle),
      );
      if (target) target.click();
      return Boolean(target);
    },
    selector,
    text,
  );

await page.screenshot({ path: `${outDir}/01-library-empty.png` });
console.log("01-library-empty");

// Sample API — first-run should be a demo, not a dead end.
await clickByText(".btn", "Try a sample API");
await page.waitForSelector(".sidebar", { timeout: 15000 });
await wait(900);
await page.screenshot({ path: `${outDir}/02-sample-open.png` });
console.log("02-sample-open");

// The graph, on a spec built to have a Customer → Order → Customer cycle.
// Toolbar actions are icon-only now — target them by aria-label, not text.
const clickLabel = (label) =>
  page.evaluate((l) => {
    const el = document.querySelector(`[aria-label="${l}"]`);
    if (el) el.click();
    return Boolean(el);
  }, label);

await clickLabel("Schema graph");
await wait(2400);
// Click a node so the detail panel is on screen in the shot.
await page.evaluate(() => {
  const node = document.querySelector(".react-flow__node");
  node?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
});
await wait(900);
await page.screenshot({ path: `${outDir}/03-graph.png` });
console.log("03-graph");
await clickLabel("Schema graph");
await wait(400);

// Back to the library — the way out that didn't exist before.
await clickLabel("Back to all APIs");
await wait(600);
await page.screenshot({ path: `${outDir}/04-library-one.png` });
console.log("04-library-one");

// Add a second API, so the library is actually a library.
const input = await page.$('input[type="file"]');
await input.uploadFile(specPath);
await page.waitForSelector(".sidebar", { timeout: 15000 });
await wait(900);
await clickLabel("Back to all APIs");
await wait(600);
await page.screenshot({ path: `${outDir}/05-library-two.png` });
console.log("05-library-two");

// Reopen the first one and switch between them.
await page.evaluate(() => document.querySelectorAll(".api-title")[1]?.click());
await page.waitForSelector(".sidebar", { timeout: 15000 });
await wait(700);
await page.evaluate(() => document.querySelector(".api-switch")?.click());
await wait(500);
await page.screenshot({ path: `${outDir}/06-switcher.png` });
console.log("06-switcher");
await page.keyboard.press("Escape");
await wait(300);

// A POST, so the schema-driven body editor and the free-text base URL are visible.
await page.evaluate(() => {
  const rows = [...document.querySelectorAll(".row")];
  rows.find((r) => r.querySelector(".method")?.textContent?.trim() === "POST")?.click();
});
await wait(700);
await page.screenshot({ path: `${outDir}/07-request.png` });
console.log("07-request");

// Light theme.
await clickLabel("Toggle theme");
await wait(500);
await page.screenshot({ path: `${outDir}/08-light.png` });
console.log("08-light");

// The scratch pad — reachable from the library, and honest about having no spec.
await clickLabel("Back to all APIs");
await wait(600);
await clickByText(".api-card.scratch", "Scratch");
await page.waitForSelector(".urlbar", { timeout: 15000 });
await page.select(".method-select", "POST");
await page.click(".url-field input");
await page.type(".url-field input", "https://api.example.com/orders");
await page.click(".editor");
await page.type(".editor", '{"sku":"abc","qty":2}');
await wait(600);
await page.screenshot({ path: `${outDir}/09-scratch.png` });
console.log("09-scratch");

console.log("page errors:", errors.length);
for (const error of errors.slice(0, 5)) console.log("  ", error);

await browser.close();
process.exit(errors.length ? 1 : 0);
