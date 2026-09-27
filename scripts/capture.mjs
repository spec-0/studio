/**
 * Drive the real Studio UI in headless Chrome and capture the user journey:
 * empty library → sample API → back → second API → switcher → operation →
 * scratch → history list and a recorded request, in both themes.
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

// History — a read-only log. Seeded directly so the shots don't depend on a
// network: a mix of APIs, mock and real, drift, a scratch call, an entry whose
// operation has since been removed, and one written before check results were
// stored (no findings, no API id).
const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const SAMPLE = "Orders API (sample)";
const order = {
  id: "8c7d1f0e-4a8b-4d0c-9a51-2f6f0d3e9b11",
  status: "paid",
  total: "42.50",
  currency: "EUR",
  giftWrap: true,
  customer: { id: "cus_19", email: "ada@example.com" },
};
const seeded = [
  {
    id: "req_seed_a",
    at: ago(3 * 24 * 60 + 17),
    method: "GET",
    path: "/orders/{orderId}",
    url: `https://api.example.com/v1/orders/${order.id}?expand=customer`,
    status: 200,
    statusText: "OK",
    ms: 184,
    bytes: 211,
    specTitle: SAMPLE,
    operationId: "GET /orders/{orderId}",
    environment: "Staging",
    headers: { Accept: "application/json", Authorization: "Bearer {{token}}" },
    validation: "mismatch",
    findings: [
      { kind: "type_mismatch", path: "$.total", message: "Expected number, got a different type." },
      { kind: "extra_field", path: "$.giftWrap", message: "Response contains `giftWrap`, not declared in the spec." },
    ],
    specVersion: "1.3.0",
    specFingerprint: "older",
    mock: false,
    responseHeaders: { "content-type": "application/json", "x-request-id": "rq_7f21" },
    responseBody: JSON.stringify(order),
  },
  {
    id: "req_seed_b",
    at: ago(125),
    method: "POST",
    path: "/orders",
    url: "https://mock.example.com/orders",
    status: 201,
    statusText: "Created",
    ms: 38,
    bytes: 160,
    specTitle: SAMPLE,
    operationId: "POST /orders",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: '{\n  "items": [{ "sku": "abc", "quantity": 2 }]\n}',
    bodyKind: "text",
    validation: "ok",
    findings: [],
    mock: true,
    responseHeaders: { "content-type": "application/json" },
    responseBody: JSON.stringify({ ...order, total: 42.5, giftWrap: undefined }),
  },
  {
    id: "req_seed_c",
    at: ago(10 * 24 * 60),
    method: "GET",
    path: "/orders",
    url: "https://api.example.com/v1/orders?status=paid&limit=20",
    status: 401,
    ms: 91,
    bytes: 64,
    specTitle: SAMPLE,
    operationId: "GET /orders",
    headers: { Accept: "application/json" },
    validation: "mismatch",
  },
  {
    id: "req_seed_d",
    at: ago(26 * 60),
    method: "GET",
    path: "/get?probe=1",
    url: "https://httpbin.org/get?probe=1",
    status: 200,
    statusText: "OK",
    ms: 312,
    bytes: 240,
    specTitle: "Scratch",
    operationId: "__scratch__",
    headers: { Accept: "*/*" },
    validation: "no_schema",
    responseHeaders: { "content-type": "application/json" },
    responseBody: '{"args":{"probe":"1"},"url":"https://httpbin.org/get?probe=1"}',
  },
  {
    id: "req_seed_e",
    at: ago(5 * 24 * 60),
    method: "DELETE",
    path: "/orders/{orderId}",
    url: `https://api.example.com/v1/orders/${order.id}`,
    status: 204,
    statusText: "No Content",
    ms: 77,
    bytes: 0,
    specTitle: SAMPLE,
    operationId: "DELETE /orders/{orderId}",
    headers: {},
    validation: "no_schema",
    checkNote: "The spec doesn't declare a schema for this response.",
    responseBody: "",
  },
].sort((a, b) => b.at.localeCompare(a.at));

await page.evaluate((entries) => {
  window.localStorage.setItem("studio:history.json", JSON.stringify(entries));
}, seeded);
await page.reload({ waitUntil: "networkidle0" });
await wait(700);

// Light theme is on from step 08. The one list across every API.
await clickLabel("History");
await page.waitForSelector(".history-filters", { timeout: 15000 });
await wait(500);
await page.screenshot({ path: `${outDir}/10-history-list-light.png` });
console.log("10-history-list-light");

const openRecord = (id) =>
  page.evaluate((needle) => {
    const rows = [...document.querySelectorAll(".history-row")];
    const row = rows.find((r) => r.getAttribute("title")?.includes(needle));
    row?.click();
    return Boolean(row);
  }, id);

// The drifted request from three days ago, against a spec that has moved on.
await openRecord(`/orders/${order.id}?expand`);
await page.waitForSelector(".record", { timeout: 15000 });
await wait(600);
await page.screenshot({ path: `${outDir}/11-history-detail-light.png` });
console.log("11-history-detail-light");

await clickByText(".record .btn", "Re-check against current spec");
await wait(500);
await page.screenshot({ path: `${outDir}/12-history-recheck-light.png` });
console.log("12-history-recheck-light");

await clickLabel("Toggle theme");
await wait(500);
await openRecord(`/orders/${order.id}?expand`);
await wait(500);
await page.screenshot({ path: `${outDir}/13-history-detail-dark.png` });
console.log("13-history-detail-dark");

// An entry whose operation is no longer in the spec still opens in full.
await openRecord(`/v1/orders/${order.id}\n204`);
await wait(500);
await page.screenshot({ path: `${outDir}/14-history-orphan-dark.png` });
console.log("14-history-orphan-dark");

// Filters: drift only.
await page.evaluate(() => {
  const box = document.querySelector(".history-check input");
  box?.click();
});
await wait(400);
await page.screenshot({ path: `${outDir}/15-history-drift-filter-dark.png` });
console.log("15-history-drift-filter-dark");

// The API's own History tab opens the same read-only view in its work area…
await clickLabel("Back to all APIs");
await wait(600);
await clickByText(".api-title", SAMPLE);
await page.waitForSelector(".sidebar .tab", { timeout: 15000 });
await wait(600);
await page.evaluate(() => {
  const tab = [...document.querySelectorAll(".sidebar .tab")].find((t) =>
    t.textContent?.startsWith("History"),
  );
  tab?.click();
});
await wait(400);
await openRecord("/orders\n201");
await page.waitForSelector(".record", { timeout: 15000 });
await wait(500);
await page.screenshot({ path: `${outDir}/16-api-record-dark.png` });
console.log("16-api-record-dark");

// …and "Copy to a new request" opens a normal editor that says it's new.
await clickByText(".record .btn", "Copy to a new request");
await page.waitForSelector(".copied-note", { timeout: 15000 });
await wait(500);
await page.screenshot({ path: `${outDir}/17-copied-request-dark.png` });
console.log("17-copied-request-dark");

console.log("page errors:", errors.length);
for (const error of errors.slice(0, 5)) console.log("  ", error);

await browser.close();
process.exit(errors.length ? 1 : 0);
