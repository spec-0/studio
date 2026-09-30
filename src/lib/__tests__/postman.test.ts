import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCollection, serializeCollection, type CollectionStep } from "../collection";
import { detectImportFormat } from "../collectionImport";
import type { LibraryEntry } from "../library";
import { importPostman, looksSecret, readTestScript, type ImportLibrary } from "../postman";
import { SAMPLE_SPEC } from "../sample";
import { parseSpec, type ParsedSpec } from "../spec";

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(resolve(here, path), "utf8");

const entry = (id: string, title: string): LibraryEntry => ({
  id,
  title,
  version: "1",
  source: { kind: "file", ref: `/specs/${id}.yaml` },
  operations: 0,
  schemas: 0,
  addedAt: "",
  openedAt: "",
});

const orders = parseSpec(SAMPLE_SPEC, "sample");
const payments = parseSpec(read("../../../scripts/fixtures/payments.yaml"), "payments");
const pets = parseSpec(read("fixtures/petstore-swagger2.json"), "pets");

function libraryOf(...pairs: Array<[LibraryEntry, ParsedSpec]>): ImportLibrary {
  return { entries: pairs.map(([e]) => e), specs: new Map(pairs.map(([e, s]) => [e.id, s])) };
}
const full = libraryOf(
  [entry("orders", "Orders API"), orders],
  [entry("payments", "Payments API"), payments],
  [entry("pets", "Swagger Petstore"), pets],
);

function fixture(name: string) {
  const format = detectImportFormat(read(`fixtures/postman/${name}`));
  if (format.kind !== "postman") throw new Error(`${name} wasn't detected as Postman`);
  return format;
}

/** A one-request Postman collection. */
function single(request: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    info: { name: "One", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
    item: [{ name: "The request", request, ...(extra.event ? { event: extra.event } : {}) }],
    ...(extra.variable ? { variable: extra.variable } : {}),
    ...(extra.auth ? { auth: extra.auth } : {}),
  };
}
const only = (data: Record<string, unknown>, library: ImportLibrary = full): CollectionStep =>
  importPostman(data, library).collection.steps[0];

// ── detection ─────────────────────────────────────────────────────────────────

describe("what kind of file it is", () => {
  it("recognises Postman v2.1 and v2.0", () => {
    expect(fixture("checkout.postman_collection.json").version).toBe("2.1");
    expect(fixture("status-page.postman_collection_v2.0.json").version).toBe("2.0");
    // No schema URL, but the shape is unmistakable.
    expect(detectImportFormat(JSON.stringify({ info: { name: "x" }, item: [] })).kind).toBe("postman");
  });

  it("passes Studio's own files through, YAML or not", () => {
    expect(detectImportFormat("version: 1\nname: Flow\nsteps: []\n").kind).toBe("studio");
    // Broken YAML is left to the collection parser, whose messages are specific.
    expect(detectImportFormat("version: [1\n").kind).toBe("studio");
  });

  it("names what it can't import and what to do instead", () => {
    const message = (text: string) => {
      const format = detectImportFormat(text);
      return format.kind === "unsupported" ? format.message : `(${format.kind})`;
    };
    expect(message(JSON.stringify({ _type: "export", __export_format: 4, resources: [] }))).toMatch(/Insomnia.*can't be imported yet/);
    expect(message("type: collection.insomnia.rest/5.0\nname: x\n")).toMatch(/Insomnia/);
    expect(message(JSON.stringify({ name: "x", version: "1", items: [], brunoConfig: {} }))).toMatch(/Bruno.*can't be imported yet/);
    expect(message("meta {\n  name: Get order\n  type: http\n}\n\nget {\n  url: {{baseUrl}}/orders\n}\n")).toMatch(/Bruno/);
    expect(message(JSON.stringify({ id: "1", name: "old", order: [], requests: [] }))).toMatch(/old v1 format.*v2\.1/);
    expect(message(JSON.stringify({ name: "Env", values: [], _postman_variable_scope: "environment" }))).toMatch(/Postman environment/);
    expect(message("openapi: 3.0.3\ninfo: { title: x, version: '1' }\npaths: {}\n")).toMatch(/API spec.*APIs tab/);
    expect(message(JSON.stringify({ log: { entries: [] } }))).toMatch(/HAR/);
    expect(message(JSON.stringify({ hello: "world" }))).toMatch(/can't tell what this file is/);
    expect(
      message(JSON.stringify({ info: { name: "x", schema: "https://schema.getpostman.com/json/collection/v1.0.0/collection.json" }, item: [] })),
    ).toMatch(/Collection v2\.1/);
  });
});

// ── the checkout fixture, end to end ──────────────────────────────────────────

describe("importing a Postman collection", () => {
  const { collection, environment, summary } = importPostman(fixture("checkout.postman_collection.json").data, full);
  const step = (key: string) => collection.steps.find((s) => s.key === key)!;

  it("keeps every request, in order, with folder names in front", () => {
    expect(collection.name).toBe("Checkout flow");
    expect(collection.steps.map((s) => s.name)).toEqual([
      "Orders / Create order",
      "Orders / Get order",
      "Orders / List paid orders",
      "Orders / Get a missing order",
      "Payments / Pay for the order",
      "Payments / Get payment",
      "Payments / Pay twice",
      "Health",
    ]);
    expect(collection.steps.map((s) => s.key)).toEqual([
      "createOrder",
      "getOrder",
      "listOrders",
      "getOrder2",
      "createPayment",
      "getPayment",
      "createPayment2",
      "health",
    ]);
  });

  it("links requests to operations across specs, and keeps the rest as plain requests", () => {
    expect(step("createOrder")).toMatchObject({ api: "orders", operation: { operationId: "createOrder", method: "POST", path: "/orders" } });
    expect(step("createPayment")).toMatchObject({ api: "payments", operation: { operationId: "createPayment" } });
    expect(step("health").api).toBeUndefined();
    expect(step("health").request).toEqual({ method: "GET", url: "{{baseUrl}}/health" });
    expect(step("health").note).toBe("Not in any spec when imported: No API in your library has GET /v1/health on this server.");
    expect(Object.keys(collection.apis).sort()).toEqual(["orders", "payments"]);
  });

  it("reads :path variables, and drops query parameters the spec doesn't have", () => {
    expect(step("getOrder2").pathParams).toEqual({ orderId: "00000000-0000-0000-0000-000000000000" });
    expect(step("listOrders").queryParams).toEqual({ status: "paid", limit: "10" });
    expect(step("listOrders").note).toMatch(/debug isn't in the spec/);
    // Studio sets Accept and Content-Type for a linked step from the spec.
    expect(step("listOrders").headers).toEqual({});
    expect(step("createOrder").headers).toEqual({ "Idempotency-Key": "checkout-{{customerId}}" });
  });

  it("uses the spec's auth scheme, with the token as a variable", () => {
    expect(step("createOrder").auth).toEqual({ scheme: "bearerAuth", type: "http", httpScheme: "bearer", value: "{{token}}" });
    // The folder's API key overrides the collection's bearer token; the payments spec has no scheme, so it's a header.
    expect(step("createPayment").auth).toBeUndefined();
    expect(step("createPayment").headers).toEqual({ "X-Payments-Key": "{{xPaymentsKey}}" });
    // `noauth` stops inheritance.
    expect(step("health").headers).toEqual({});
  });

  it("turns status checks into expected statuses", () => {
    expect(step("createOrder").expect).toEqual({ status: "201" });
    expect(step("getOrder2").expect).toEqual({ status: "404" });
    expect(step("createPayment2").expect).toEqual({ status: "4XX" });
    // `oneOf([200, 201])` is any 2xx: the default, so nothing is stored.
    expect(step("createPayment").expect).toBeUndefined();
    expect(summary.statuses).toEqual([
      { key: "createOrder", status: "201" },
      { key: "getOrder", status: "200" },
      { key: "getOrder2", status: "404" },
      { key: "createPayment2", status: "4XX" },
    ]);
  });

  it("turns variables a script set into references to the step's response", () => {
    expect(step("getOrder").pathParams).toEqual({ orderId: "{{steps.createOrder.body.id}}" });
    expect(step("createPayment").body).toContain('"orderId": "{{steps.createOrder.body.id}}"');
    expect(step("createPayment").body).toContain('"amount": {{steps.createOrder.body.total.amount}}');
    expect(step("getPayment").pathParams).toEqual({ paymentId: "{{steps.createPayment.body.id}}" });
    expect(summary.chained.map((c) => c.variable)).toEqual(["orderId", "orderTotal", "paymentId"]);
  });

  it("lists scripts in the step's note", () => {
    expect(step("createPayment").note).toMatch(/pre-request and test script; Studio doesn't run scripts/);
    expect(step("createOrder").note).toMatch(/status check became the expected status \(201\)/);
    expect(summary.scripts).toBe(5);
    expect(summary.warnings.join(" ")).toMatch(/collection itself had scripts/);
    expect(summary.warnings.join(" ")).toMatch(/\{\{\$guid\}\}/);
  });

  it("never writes a literal secret into the collection", () => {
    const { text } = serializeCollection(collection);
    expect(text).not.toMatch(/demo-token|demo-pay-key|demo-hook-secret/);
    expect(text).toContain('value: "{{token}}"');
  });

  it("offers the variables and the credentials as an environment, secrets marked", () => {
    expect(environment?.name).toBe("Checkout flow");
    const byName = Object.fromEntries(environment!.variables.map((v) => [v.name, v]));
    expect(byName.baseUrl).toEqual({ name: "baseUrl", value: "https://api.example.com/v1", secret: false });
    expect(byName.webhookSecret.secret).toBe(true);
    expect(byName.token).toEqual({ name: "token", value: "demo-token-7f3a9c", secret: true });
    expect(byName.xPaymentsKey).toEqual({ name: "xPaymentsKey", value: "demo-pay-key-2b8e41", secret: true });
  });

  it("counts what happened", () => {
    expect(summary.requests).toBe(8);
    expect(summary.linked).toEqual([
      { api: "Orders API", count: 4 },
      { api: "Payments API", count: 3 },
    ]);
    expect(summary.notInSpec.map((n) => n.key)).toEqual(["health"]);
    expect(summary.unchained).toEqual([]);
  });

  it("round-trips through the collection file", () => {
    const { text } = serializeCollection(collection);
    const again = parseCollection(text);
    expect(again.steps.map((s) => [s.key, s.expect?.status ?? null])).toEqual(
      collection.steps.map((s) => [s.key, s.expect?.status ?? null]),
    );
    expect(again.steps[7].note).toBe(collection.steps[7].note);
  });
});

describe("the pet shop fixture: bodies, older script syntax, a local server", () => {
  const { collection, environment, summary } = importPostman(fixture("pet-shop-admin.postman_collection.json").data, full);
  const step = (key: string) => collection.steps.find((s) => s.key === key)!;

  it("matches a server with a base path, preferring literal segments", () => {
    expect(step("loginUser").operation).toMatchObject({ path: "/user/login" });
    // GET /pet/findByStatus could be /pet/{petId}; the literal one wins.
    expect(step("findPetsByStatus").operation?.path).toBe("/pet/findByStatus");
    expect(step("updatePetWithForm").pathParams).toEqual({ petId: "10" });
  });

  it("maps an API key to the spec's apiKey scheme", () => {
    expect(step("loginUser").auth).toMatchObject({ scheme: "api_key", type: "apiKey", in: "header", paramName: "api_key", value: "{{apiKey}}" });
  });

  it("brings form bodies across as the step sends them", () => {
    expect(step("updatePetWithForm").body).toEqual({
      kind: "form",
      fields: [
        { key: "name", value: "Rex II" },
        { key: "status", value: "sold" },
      ],
    });
    expect(step("uploadFile").body).toEqual({
      kind: "multipart",
      parts: [
        { name: "additionalMetadata", value: "front view" },
        { name: "file", path: "/Users/sam/Pictures/rex.jpg", fileName: "rex.jpg" },
      ],
    });
    expect(step("uploadFile").note).toMatch(/rex\.jpg, a path on the computer the collection was made on/);
    // An unlinked request sends text, so its form is encoded, variables kept.
    expect(step("localStockService").body).toBe("sku=dog%20food%20%26%20treats&count={{count}}");
    expect(step("localStockService").headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(JSON.parse(step("searchGraphQL").body as string)).toEqual({
      query: "query { pets(status: AVAILABLE) { id name } }",
      variables: { first: 5 },
    });
  });

  it("follows JSON.parse(responseBody) and postman.setEnvironmentVariable", () => {
    expect(step("loginUser").expect).toEqual({ status: "200" });
    expect(step("findPetsByStatus").headers["X-Session"]).toBe("{{steps.loginUser.body.message}}");
    expect(summary.chained).toEqual([{ variable: "session", reference: "{{steps.loginUser.body.message}}" }]);
  });

  it("takes credentials out of headers and basic auth", () => {
    expect(step("localStockService").headers["X-Stock-Token"]).toBe("{{xStockToken}}");
    expect(step("localStockService").headers.Authorization).toBe("Basic {{basicAuth}}");
    const byName = Object.fromEntries(environment!.variables.map((v) => [v.name, v]));
    expect(byName.basicAuth).toEqual({ name: "basicAuth", value: btoa("stock:hunter2"), secret: true });
    expect(byName.apiKey.secret).toBe(true);
    expect(byName.adminPassword.secret).toBe(true);
    expect(serializeCollection(collection).text).not.toMatch(/hunter2|abc\.def\.ghi|c3RvY2s6aHVudGVyMg/);
  });

  it("keeps requests to servers no spec declares as plain requests", () => {
    expect(summary.notInSpec.map((n) => n.key)).toEqual(["localStockService", "searchGraphQL"]);
    expect(step("searchGraphQL").request?.url).toBe("https://graph.example.net/graphql");
  });
});

describe("the v2.0 fixture", () => {
  const { collection, environment } = importPostman(fixture("status-page.postman_collection_v2.0.json").data, full);

  it("reads object-style auth, string headers and string URLs", () => {
    const [list, customer] = collection.steps;
    expect(list.auth?.value).toBe("{{token}}");
    expect(list.headers).toEqual({ "X-Trace": "on" });
    expect(list.queryParams).toEqual({ limit: "5" });
    // Sent to the second server, as in Postman.
    expect(list.target).toEqual({ kind: "server", url: "https://staging.api.example.com/v1" });
    expect(customer.expect).toEqual({ status: "404" });
    // Nothing to put in an environment: the token was already a variable.
    expect(environment).toBeNull();
  });
});

// ── linking rules ─────────────────────────────────────────────────────────────

describe("linking", () => {
  it("links by path when the host is a variable with no value, and keeps the variable as the target", () => {
    const step = only(single({ method: "GET", url: "{{ordersHost}}/orders/:id", header: [] }));
    // `:id` isn't the spec's name for it, but it's in the position of `{orderId}`.
    expect(step.operation?.operationId).toBe("getOrder");
    expect(step.pathParams).toEqual({ orderId: "{{id}}" });
    expect(step.target).toEqual({ kind: "custom", url: "{{ordersHost}}" });
  });

  it("resolves the host from collection variables, several levels deep", () => {
    const step = only(
      single(
        { method: "GET", url: "{{baseUrl}}/orders/{{orderId}}" },
        {
          variable: [
            { key: "host", value: "https://staging.api.example.com" },
            { key: "baseUrl", value: "{{host}}/v1" },
          ],
        },
      ),
    );
    expect(step.operation?.operationId).toBe("getOrder");
    expect(step.pathParams).toEqual({ orderId: "{{orderId}}" });
    expect(step.target).toEqual({ kind: "server", url: "https://staging.api.example.com/v1" });
  });

  it("tolerates a trailing slash and a URL without a scheme", () => {
    expect(only(single({ method: "GET", url: "https://api.example.com/v1/orders/" })).operation?.operationId).toBe("listOrders");
    expect(only(single({ method: "GET", url: "api.example.com/v1/orders" })).operation?.operationId).toBe("listOrders");
  });

  it("needs the method and the base path to agree", () => {
    expect(only(single({ method: "DELETE", url: "https://api.example.com/v1/orders" })).api).toBeUndefined();
    // The right host with the wrong base path is a different API.
    expect(only(single({ method: "GET", url: "https://api.example.com/v2/orders" })).api).toBeUndefined();
    // A host no spec declares isn't guessed at.
    expect(only(single({ method: "GET", url: "https://orders.example.net/v1/orders" })).api).toBeUndefined();
  });

  it("links a server on this computer by path, and keeps its address", () => {
    const step = only(single({ method: "GET", url: "http://localhost:8080/v1/orders" }));
    expect(step.operation?.operationId).toBe("listOrders");
    expect(step.target).toEqual({ kind: "custom", url: "http://localhost:8080/v1" });
  });

  it("leaves a request unlinked when it matches operations in more than one API", () => {
    const copy = parseSpec(SAMPLE_SPEC.replace("title: Orders API (sample)", "title: Orders copy"), "copy");
    const library = libraryOf([entry("orders", "Orders API"), orders], [entry("copy", "Orders copy"), copy]);
    const step = only(single({ method: "GET", url: "{{baseUrl}}/orders" }), library);
    expect(step.api).toBeUndefined();
    expect(step.note).toMatch(/more than one API \(Orders API, Orders copy\)/);
  });

  it("takes the newest copy when the same API is in the library twice", () => {
    const older = { ...entry("pay1", "Payments API"), addedAt: "2026-01-01T00:00:00Z", openedAt: "2026-01-01T00:00:00Z" };
    const newer = { ...entry("pay2", "Payments API"), addedAt: "2026-02-01T00:00:00Z", openedAt: "2026-02-01T00:00:00Z" };
    const library = libraryOf([older, payments], [newer, payments]);
    const { collection } = importPostman(single({ method: "POST", url: "https://payments.invalid/v1/payments" }), library);
    expect(collection.steps[0].operation?.operationId).toBe("createPayment");
    expect(collection.apis[collection.steps[0].api!].source.ref).toBe("/specs/pay2.yaml");
  });

  it("says so when the library is empty", () => {
    const step = only(single({ method: "GET", url: "https://api.example.com/v1/orders" }), { entries: [], specs: new Map() });
    expect(step.request).toEqual({ method: "GET", url: "https://api.example.com/v1/orders" });
    expect(step.note).toMatch(/library has no APIs yet/);
  });

  it("keeps an unlinked request's query and :path values in its URL", () => {
    const step = only(
      single({
        method: "GET",
        url: {
          raw: "https://elsewhere.example.net/things/:thing?x=1",
          host: ["elsewhere", "example", "net"],
          path: ["things", ":thing"],
          query: [{ key: "x", value: "1" }, { key: "y", value: "2", disabled: true }],
          variable: [{ key: "thing", value: "t_1" }],
        },
      }),
    );
    expect(step.request?.url).toBe("https://elsewhere.example.net/things/t_1?x=1");
  });
});

// ── scripts ───────────────────────────────────────────────────────────────────

describe("reading test scripts", () => {
  it("finds the status a script checks", () => {
    expect(readTestScript("pm.response.to.have.status(404);").status).toBe("404");
    expect(readTestScript("pm.expect(pm.response.code).to.equal(409);").status).toBe("409");
    expect(readTestScript("pm.expect(pm.response.code).to.be.oneOf([400, 422]);").status).toBe("4XX");
    expect(readTestScript('tests["ok"] = responseCode.code === 201;').status).toBe("201");
    expect(readTestScript("pm.response.to.be.notFound;").status).toBe("404");
    expect(readTestScript("pm.response.to.be.serverError;").status).toBe("5XX");
    expect(readTestScript("pm.response.to.be.ok;").status).toBe("2XX");
    expect(readTestScript("pm.response.to.not.be.error;").status).toBeUndefined();
    expect(readTestScript("pm.expect(pm.response.json().ok).to.eql(true);").status).toBeUndefined();
  });

  it("takes no status when a script checks two", () => {
    const facts = readTestScript("if (x) pm.response.to.have.status(200); else pm.response.to.have.status(404);");
    expect(facts.status).toBeUndefined();
    expect(facts.statusAmbiguous).toBe(true);
  });

  it("finds where a variable's value comes from", () => {
    const facts = readTestScript(
      [
        'pm.environment.set("a", pm.response.json().data.items[0].id);',
        "const body = pm.response.json();",
        "pm.collectionVariables.set('b', body[\"order-id\"]);",
        'pm.globals.set("c", pm.response.headers.get("Location"));',
        'pm.environment.set("d", pm.response.json().items.length);',
        'pm.environment.set("e", Date.now());',
        'pm.environment.set("f", pm.response.json()["a key"]);',
      ].join("\n"),
    );
    expect(facts.sets).toEqual([
      { variable: "a", source: { kind: "body", path: ["data", "items", 0, "id"] } },
      { variable: "b", source: { kind: "body", path: ["order-id"] } },
      { variable: "c", source: { kind: "header", name: "Location" } },
      // `.length` reads as a field; Studio's reference would look for a field called length.
      { variable: "d", source: { kind: "body", path: ["items", "length"] } },
      { variable: "e", source: null },
      { variable: "f", source: null },
    ]);
  });

  it("leaves a variable set by more than one step, or worked out, as a variable and says so", () => {
    const test = (exec: string) => [{ listen: "test", script: { exec: [exec] } }];
    const data = {
      info: { name: "x", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
      item: [
        { name: "One", event: test('pm.environment.set("id", pm.response.json().id);'), request: { method: "POST", url: "https://a.example.net/x" } },
        { name: "Two", event: test('pm.environment.set("id", pm.response.json().other);'), request: { method: "POST", url: "https://a.example.net/y" } },
        { name: "Three", event: test('pm.environment.set("stamp", "t" + Date.now());'), request: { method: "GET", url: "https://a.example.net/{{id}}" } },
        { name: "Four", request: { method: "GET", url: "https://a.example.net/{{id}}/{{stamp}}" } },
      ],
    };
    const { collection, summary } = importPostman(data, full);
    expect(collection.steps[3].request?.url).toBe("https://a.example.net/{{id}}/{{stamp}}");
    expect(summary.unchained).toEqual([
      { variable: "id", reason: "more than one step sets it" },
      { variable: "stamp", reason: "the script works it out in a way Studio can't follow" },
    ]);
  });

  it("uses a response header as a header reference", () => {
    const data = {
      info: { name: "x", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
      item: [
        {
          name: "Create",
          event: [{ listen: "test", script: { exec: ['pm.environment.set("where", pm.response.headers.get("Location"));'] } }],
          request: { method: "POST", url: "https://api.example.com/v1/orders" },
        },
        { name: "Follow", request: { method: "GET", url: "{{where}}" } },
      ],
    };
    const { collection } = importPostman(data, full);
    expect(collection.steps[1].request?.url).toBe("{{steps.createOrder.headers.Location}}");
  });
});

// ── secrets ───────────────────────────────────────────────────────────────────

describe("secrets", () => {
  it("knows a secret-looking name", () => {
    for (const name of ["token", "accessToken", "client_secret", "X-API-Key", "password", "sessionId"]) expect(looksSecret(name)).toBe(true);
    for (const name of ["baseUrl", "orderId", "customerId", "limit"]) expect(looksSecret(name)).toBe(false);
  });

  it("takes a literal bearer token and a password in a JSON body out, reusing one variable for one value", () => {
    const data = {
      info: { name: "x", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
      auth: { type: "bearer", bearer: [{ key: "token", value: "tok_123" }] },
      item: [
        { name: "Login", request: { method: "POST", url: "https://auth.example.net/login", body: { mode: "raw", raw: '{"user":"sam","password":"p@ss w0rd"}' } } },
        { name: "Again", request: { method: "GET", url: "https://auth.example.net/me", header: [{ key: "Authorization", value: "Bearer tok_123" }] } },
      ],
    };
    const { collection, environment } = importPostman(data, full);
    expect(collection.steps[0].body).toBe('{"user":"sam","password":"{{password}}"}');
    expect(collection.steps[0].headers.Authorization).toBe("Bearer {{token}}");
    expect(collection.steps[1].headers.Authorization).toBe("Bearer {{token}}");
    expect(environment?.variables).toEqual([
      { name: "token", value: "tok_123", secret: true },
      { name: "password", value: "p@ss w0rd", secret: true },
    ]);
    expect(serializeCollection(collection).text).not.toMatch(/tok_123|p@ss/);
  });

  it("doesn't take a name a collection variable already has", () => {
    const data = single(
      { method: "GET", url: "https://a.example.net/", header: [{ key: "X-Api-Key", value: "live_1" }] },
      { variable: [{ key: "xApiKey", value: "different" }] },
    );
    const { collection, environment } = importPostman(data, full);
    expect(collection.steps[0].headers["X-Api-Key"]).toBe("{{xApiKey2}}");
    expect(environment?.variables.map((v) => [v.name, v.secret])).toEqual([
      ["xApiKey", true],
      ["xApiKey2", true],
    ]);
  });

  it("notes auth it can't bring across", () => {
    const step = only(single({ method: "GET", url: "https://a.example.net/", auth: { type: "oauth2", oauth2: [] } }));
    expect(step.note).toMatch(/oauth2 auth, which wasn't brought across/);
  });
});
