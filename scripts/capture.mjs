/**
 * Drive the real Studio UI in headless Chrome and capture the user journey:
 * empty library → sample API → back → second API → switcher → operation →
 * scratch → history list and a recorded request → every Settings section →
 * Mocks (signed out and in) → MCP, in both themes → "Create a mock server",
 * step by step, and with a limit already reached → the main screens at the
 * minimum window width.
 *
 *   node scripts/capture.mjs <spec-file> <out-dir>
 *
 * The limit-reached shot needs a second spec: SECOND_SPEC, or `<spec>-2.yaml`
 * next to the first.
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

// Icon buttons are targeted by aria-label; tabs by their text.
const clickLabel = (label) =>
  page.evaluate((l) => {
    const el = document.querySelector(`[aria-label^="${l}"]`);
    if (el) el.click();
    return Boolean(el);
  }, label);

/** A tab in the top bar (`.nav-tab`), the API bar (`.segment`) or Settings (`.settings-tab`). */
const clickTab = (selector, text) =>
  page.evaluate(
    (sel, needle) => {
      const tab = [...document.querySelectorAll(`${sel}[role="tab"]`)].find(
        (el) => el.textContent?.trim() === needle,
      );
      tab?.click();
      return Boolean(tab);
    },
    selector,
    text,
  );

const must = async (promise, what) => {
  if (!(await promise)) throw new Error(`Couldn't find ${what}`);
};

const toggleTheme = async () => {
  await page.keyboard.down("Control");
  await page.keyboard.press("d");
  await page.keyboard.up("Control");
  await wait(400);
};

// The graph is a tab of its own now, next to Operations, Schemas and Document.
await must(clickTab(".segment", "Graph"), "the Graph tab");
await wait(2400);
// Click a node so the detail panel is on screen in the shot.
await page.evaluate(() => {
  const node = document.querySelector(".react-flow__node");
  node?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
});
await wait(900);
await page.screenshot({ path: `${outDir}/03-graph.png` });
console.log("03-graph");
await must(clickTab(".segment", "Document"), "the Document tab");
await wait(1500);
await page.screenshot({ path: `${outDir}/03b-document.png` });
console.log("03b-document");
await must(clickTab(".segment", "Schemas"), "the Schemas tab");
await wait(500);
await page.screenshot({ path: `${outDir}/03c-schemas.png` });
console.log("03c-schemas");
await must(clickTab(".segment", "Operations"), "the Operations tab");
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
await toggleTheme();
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
await must(clickTab(".nav-tab", "History"), "the History tab");
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

await toggleTheme();
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
await must(clickTab(".nav-tab", "APIs"), "the APIs tab");
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

// Settings, a full page with a section list. Dark first (the theme is dark
// from step 13), then light.
const SECTIONS = [
  ["account", "Account & Spec0"],
  ["network", "Network"],
  ["updates", "Updates"],
  ["appearance", "Appearance"],
  ["mcp", "MCP"],
  ["data", "Data & privacy"],
];
const shootSettings = async (theme, n) => {
  await must(clickLabel("Settings"), "the Settings button");
  await page.waitForSelector(".settings-nav", { timeout: 15000 });
  for (const [id, label] of SECTIONS) {
    await must(clickTab(".settings-tab", label), `the ${label} section`);
    await page.waitForSelector(`[data-section="${id}"]`, { timeout: 5000 });
    await wait(350);
    await page.screenshot({ path: `${outDir}/${n}-settings-${id}-${theme}.png` });
    console.log(`${n}-settings-${id}-${theme}`);
  }
};
const shootTabs = async (theme, n, suffix = "") => {
  await must(clickTab(".nav-tab", "Mocks"), "the Mocks tab");
  await wait(600);
  await page.screenshot({ path: `${outDir}/${n}-mocks${suffix}-${theme}.png` });
  console.log(`${n}-mocks${suffix}-${theme}`);
  await must(clickTab(".nav-tab", "MCP"), "the MCP tab");
  await wait(400);
  await page.screenshot({ path: `${outDir}/${n + 1}-mcp-${theme}.png` });
  console.log(`${n + 1}-mcp-${theme}`);
};

await shootSettings("dark", 18);
await shootTabs("dark", 19);
await toggleTheme();
await shootSettings("light", 21);
await shootTabs("light", 22);

/** Screenshot now, then in the other theme, and switch back. */
const shootBoth = async (name, theme) => {
  const other = theme === "light" ? "dark" : "light";
  await page.screenshot({ path: `${outDir}/${name}-${theme}.png` });
  console.log(`${name}-${theme}`);
  await toggleTheme();
  await page.screenshot({ path: `${outDir}/${name}-${other}.png` });
  console.log(`${name}-${other}`);
  await toggleTheme();
};
const openJourneyFromLibrary = async (title) => {
  await must(clickTab(".nav-tab", "APIs"), "the APIs tab");
  await wait(400);
  await page.evaluate(() => document.querySelector('[aria-label="Back to all APIs"]')?.click());
  await wait(400);
  const found = await page.evaluate((needle) => {
    const card = [...document.querySelectorAll(".api-card")].find((c) =>
      c.querySelector(".api-title")?.textContent?.includes(needle),
    );
    const button = card?.querySelector(".card-mock");
    button?.click();
    return Boolean(button);
  }, title);
  if (!found) throw new Error(`No mock button on ${title}`);
  await page.waitForSelector(".modal.journey", { timeout: 5000 });
  await wait(400);
};
const closeJourney = async () => {
  await page.keyboard.press("Escape");
  await wait(300);
};

// The theme is light here. The library card offers "Create mock"; signed
// out, the journey starts at sign-in.
await must(clickTab(".nav-tab", "APIs"), "the APIs tab");
await wait(400);
await page.evaluate(() => document.querySelector('[aria-label="Back to all APIs"]')?.click());
await wait(400);
const UPLOADED = await page.evaluate(
  () =>
    [...document.querySelectorAll(".api-card")]
      .find((card) => card.querySelector(".tag.src-file"))
      ?.querySelector(".api-title")?.textContent ?? "",
);
await openJourneyFromLibrary(UPLOADED);
await shootBoth("24a-journey-sign-in", "light");
await closeJourney();

// Signed in: a session and the org's mocks, answered here so no request
// leaves the machine.
const FAKE_API = "https://spec0.invalid";
// What the fake Spec0 answers. Changed between shots to show each state.
const fake = {
  entitlements: {
    features: [
      { key: "max_mock_servers", limit: 4, used: 3, enabled: true },
      { key: "max_internal_apis", limit: 10, used: 2, enabled: true },
    ],
  },
  teams: [
    { id: "t1", name: "Payments" },
    { id: "t2", name: "Checkout" },
  ],
  mocks: [
    { mockServerId: "m1", apiId: "a1", apiName: "Orders API", mockBaseUrl: "/mock/acme/orders-api", specVersion: "1.4.0" },
    { mockServerId: "m2", apiId: "a2", apiName: "Payments", name: "Payments sandbox", mockBaseUrl: "/mock/acme/payments", specVersion: "2.0.1" },
    { mockServerId: "m3", apiId: "a3", apiName: "Inventory", mockBaseUrl: "/mock/acme/inventory" },
  ],
};
const mockCalls = [];
const answer = (method, path) => {
  if (path.endsWith("/orgs/entitlements")) return fake.entitlements ? [200, fake.entitlements] : [404, {}];
  if (path.endsWith("/teams")) return [200, fake.teams];
  if (method === "POST" && path.endsWith("/apis/team")) {
    return [200, { apiId: "a9", apiName: "demo-api", version: "1.0.0", created: true }];
  }
  if (method === "POST" && path.endsWith("/mocks")) {
    // No key on create, so the journey has to fetch it.
    return [200, { mockServerId: "m9", apiId: "a9", apiName: "demo-api", mockBaseUrl: "/mock/acme/demo-api", created: true }];
  }
  const key = path.match(/\/mocks\/([^/]+)\/api-key(\/regenerate)?$/);
  if (key) return [200, { mockServerId: key[1], apiKey: `mk_demo_${key[1]}_${key[2] ? "new" : "7f3a9c21"}`, apiKeyPreview: "mk_…" }];
  if (path.endsWith("/mocks")) return [200, fake.mocks];
  if (path.endsWith("/orgs/summary")) return [200, { name: "Acme" }];
  return [200, []];
};
await page.setRequestInterception(true);
page.on("request", (request) => {
  if (!request.url().startsWith(FAKE_API)) return void request.continue();
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
  if (request.method() === "OPTIONS") return void request.respond({ status: 204, headers: cors });
  const path = new globalThis.URL(request.url()).pathname;
  // Calls to a mock itself: remember the key they carried.
  if (path.startsWith("/mock/")) mockCalls.push({ path, key: request.headers()["x-mock-api-key"] ?? null });
  const [status, body] = answer(request.method(), path);
  void request.respond({ status, headers: cors, contentType: "application/json", body: JSON.stringify(body) });
});
await page.evaluate((apiUrl) => {
  window.localStorage.setItem(
    "studio:session.json",
    JSON.stringify({
      apiUrl,
      appUrl: apiUrl,
      orgId: "org_demo",
      orgName: "Acme",
      token: "demo",
      source: "cli",
      connectedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    }),
  );
}, FAKE_API);
await page.reload({ waitUntil: "networkidle0" });
await wait(600);
await must(clickTab(".nav-tab", "Mocks"), "the Mocks tab");
await page.waitForSelector(".mocks-table", { timeout: 15000 });
await wait(400);
await page.screenshot({ path: `${outDir}/24-mocks-signed-in-light.png` });
console.log("24-mocks-signed-in-light");
await must(clickLabel("Signed in"), "the status chip");
await page.waitForSelector('[data-section="account"]', { timeout: 5000 });
await wait(350);
await page.screenshot({ path: `${outDir}/25-settings-account-signed-in-light.png` });
console.log("25-settings-account-signed-in-light");
await toggleTheme();
await must(clickTab(".nav-tab", "Mocks"), "the Mocks tab");
await wait(400);
await page.screenshot({ path: `${outDir}/26-mocks-signed-in-dark.png` });
console.log("26-mocks-signed-in-dark");

// "Create a mock server" signed in, dark theme here. Two teams, so the team
// step shows; usage comes from the (fake) server's numbers.
await openJourneyFromLibrary(UPLOADED);
await page.waitForSelector(".journey-main select", { timeout: 5000 });
await shootBoth("26a-journey-team", "dark");
await clickByText(".journey-main .btn", "Continue");
await page.waitForSelector(".journey-main input", { timeout: 5000 });
await wait(300);
await shootBoth("26b-journey-publish", "dark");
await clickByText(".journey-main .btn", "Publish");
await page.waitForFunction(() => document.querySelector(".journey-heading")?.textContent === "Create the mock", { timeout: 5000 });
await wait(300);
await shootBoth("26c-journey-mock", "dark");
await clickByText(".journey-main .btn", "Create mock");
await page.waitForFunction(() => document.querySelector(".journey-heading")?.textContent?.includes("ready"), { timeout: 5000 });
await wait(600);
await shootBoth("26d-journey-done", "dark");
// "Send a test request" straight after creating must send, first time, with the key.
const expectTestSend = async (what) => {
  const before = mockCalls.length;
  await clickByText(".journey-main .btn", "Send a test request");
  await page.waitForSelector(".status-pill", { timeout: 10000 }).catch(() => {});
  await wait(500);
  const call = mockCalls[before];
  if (!call) throw new Error(`${what}: no request reached the mock`);
  if (call.key !== "mk_demo_m9_7f3a9c21") throw new Error(`${what}: sent without the stored key`);
  console.log(`${what}: sent ${call.path} with the key`);
};
await expectTestSend("test request from the library");
await page.screenshot({ path: `${outDir}/26g-api-targets-mock-dark.png` });
console.log("26g-api-targets-mock-dark");

// Again from the API bar, where the address and operation already match.
await clickByText(".apibar .btn", "Mock");
await page.waitForSelector(".modal.journey", { timeout: 5000 });
await wait(300);
await expectTestSend("test request from the API bar");

// Regenerating asks first.
await clickByText(".apibar .btn", "Mock");
await page.waitForSelector(".modal.journey", { timeout: 5000 });
await wait(300);
await clickByText(".journey-main .btn", "Regenerate key");
await wait(300);
await shootBoth("26e-journey-regenerate-confirm", "dark");
await closeJourney();

// The library now shows the mock on that card.
await clickLabel("Back to all APIs");
await wait(500);
await page.screenshot({ path: `${outDir}/26f-library-after-dark.png` });
console.log("26f-library-after-dark");

// A limit already reached: said up front, before any step.
fake.entitlements = {
  features: [
    { key: "max_mock_servers", limit: 2, used: 2, enabled: true },
    { key: "max_internal_apis", limit: 10, used: 3, enabled: true },
  ],
};
await clickLabel("Back to all APIs");
await wait(400);
const second = await page.$('input[type="file"]');
await second.uploadFile(process.env.SECOND_SPEC ?? specPath.replace(/\.ya?ml$/, "-2.yaml"));
await page.waitForSelector(".sidebar", { timeout: 15000 });
await wait(500);
const SECOND = await page.evaluate(() => document.querySelector(".api-switch .spec-name")?.textContent ?? "");
await openJourneyFromLibrary(SECOND);
await page.waitForSelector(".journey-main .verdict.warn", { timeout: 5000 });
await shootBoth("26h-journey-limit-reached", "dark");
await closeJourney();

// The Mocks tab: create from here (pick an API), and key actions per mock.
fake.entitlements = null;
await must(clickTab(".nav-tab", "Mocks"), "the Mocks tab");
await page.waitForSelector(".mocks-table", { timeout: 15000 });
await clickByText(".btn", "Refresh");
await wait(600);
await clickLabel("Show the Orders API mock key");
await wait(500);
await shootBoth("26i-mocks-keys", "dark");
await clickLabel("Regenerate the Payments mock key");
await wait(300);
await page.screenshot({ path: `${outDir}/26j-mocks-regenerate-confirm-dark.png` });
console.log("26j-mocks-regenerate-confirm-dark");
await clickByText(".mock-key-confirm .btn", "Keep");
await clickByText(".library-head .btn", "Create a mock server");
await page.waitForSelector(".modal.journey", { timeout: 5000 });
await wait(300);
await shootBoth("26k-journey-pick", "dark");
await closeJourney();

// The minimum window width, 960 by 600: the two bars must still fit.
await page.setViewport({ width: 960, height: 600, deviceScaleFactor: 2 });
await must(clickTab(".nav-tab", "APIs"), "the APIs tab");
await wait(300);
await clickByText(".api-title", SAMPLE);
await page.waitForSelector(".apibar", { timeout: 15000 });
await wait(600);
await page.screenshot({ path: `${outDir}/27-min-width-api-dark.png` });
console.log("27-min-width-api-dark");
await must(clickTab(".segment", "Graph"), "the Graph tab");
await wait(1500);
await page.screenshot({ path: `${outDir}/28-min-width-graph-dark.png` });
console.log("28-min-width-graph-dark");
await toggleTheme();
await must(clickTab(".segment", "Operations"), "the Operations tab");
await wait(400);
await page.screenshot({ path: `${outDir}/29-min-width-api-light.png` });
console.log("29-min-width-api-light");
// An API with a mock: every action on the bar, and the name still in full.
await clickLabel("Back to all APIs");
await wait(400);
await clickByText(".api-title", UPLOADED);
await page.waitForSelector(".apibar", { timeout: 15000 });
await wait(500);
await page.screenshot({ path: `${outDir}/29b-min-width-api-with-mock-light.png` });
console.log("29b-min-width-api-with-mock-light");
await toggleTheme();
await page.screenshot({ path: `${outDir}/29c-min-width-api-with-mock-dark.png` });
console.log("29c-min-width-api-with-mock-dark");
await toggleTheme();
await must(clickLabel("Settings"), "the Settings button");
await must(clickTab(".settings-tab", "Network"), "the Network section");
await wait(400);
await page.screenshot({ path: `${outDir}/30-min-width-settings-light.png` });
console.log("30-min-width-settings-light");

console.log("page errors:", errors.length);
for (const error of errors.slice(0, 5)) console.log("  ", error);

await browser.close();
process.exit(errors.length ? 1 : 0);
