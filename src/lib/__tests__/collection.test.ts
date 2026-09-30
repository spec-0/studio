import { afterEach, describe, expect, it } from "vitest";
import {
  COLLECTION_FORMAT_VERSION,
  CollectionFormatError,
  baseStepKey,
  dirOf,
  moveStep,
  newCollection,
  parseCollection,
  relativePath,
  renameStepKey,
  resolvePath,
  serializeCollection,
  suggestedCollectionFileName,
  uniqueStepKey,
  type Collection,
} from "../collection";
import { setKnownSecrets } from "../redact";

afterEach(() => setKnownSecrets([]));

function sample(): Collection {
  return {
    ...newCollection("Checkout flow"),
    description: "Create an order and pay for it.",
    apis: {
      orders: { title: "Orders API", source: { kind: "file", ref: "/repo/specs/orders.yaml" } },
      payments: { title: "Payments API", source: { kind: "url", ref: "https://example.com/payments.yaml" } },
      catalog: { title: "Catalog", source: { kind: "spec0", ref: "spec0:api_123" } },
      demo: { title: "Orders API (sample)", source: { kind: "sample", ref: "sample" } },
    },
    steps: [
      {
        key: "createOrder",
        name: "Create an order",
        api: "orders",
        operation: { operationId: "createOrder", method: "POST", path: "/orders" },
        pathParams: {},
        queryParams: {},
        headers: { "X-Trace": "{{traceId}}" },
        body: '{\n  "customerId": "cus_1"\n}',
        auth: { scheme: "bearerAuth", type: "http", httpScheme: "bearer", value: "{{token}}" },
      },
      {
        key: "pay",
        api: "payments",
        operation: { operationId: "createPayment", method: "POST", path: "/payments" },
        target: { kind: "mock" },
        pathParams: {},
        queryParams: {},
        headers: {},
        body: { kind: "form", fields: [{ key: "order", value: "{{steps.createOrder.body.id}}" }] },
      },
      {
        key: "getOrder",
        api: "orders",
        operation: { method: "GET", path: "/orders/{orderId}" },
        target: { kind: "server", url: "https://staging.example.com/v1" },
        pathParams: { orderId: "{{steps.createOrder.body.id}}" },
        queryParams: { expand: "customer" },
        headers: {},
      },
      {
        key: "local",
        api: "orders",
        operation: { operationId: "listOrders", method: "GET", path: "/orders" },
        target: { kind: "local-mock" },
        pathParams: {},
        queryParams: {},
        headers: {},
      },
      {
        key: "health",
        request: { method: "GET", url: "{{baseUrl}}/health" },
        target: { kind: "custom", url: "http://localhost:8080" },
        pathParams: {},
        queryParams: {},
        headers: { Accept: "text/plain" },
      },
    ],
  };
}

describe("collection file format", () => {
  it("round-trips through YAML", () => {
    const original = sample();
    const { text, warnings } = serializeCollection(original);
    expect(warnings).toEqual([]);
    const parsed = parseCollection(text, { id: original.id });
    expect(parsed.name).toBe(original.name);
    expect(parsed.description).toBe(original.description);
    expect(parsed.apis).toEqual(original.apis);
    expect(parsed.stopOnFailure).toBe(true);
    // Text bodies gain a trailing newline so the YAML block is clean; nothing else changes.
    expect(parsed.steps.map((s) => ({ ...s, body: typeof s.body === "string" ? s.body.trimEnd() : s.body }))).toEqual(
      original.steps,
    );
  });

  it("writes a version and reads it back", () => {
    const { text } = serializeCollection(sample());
    expect(text).toMatch(new RegExp(`^version: ${COLLECTION_FORMAT_VERSION}$`, "m"));
  });

  it("is readable: no empty maps, a block body, the target as a word", () => {
    const { text } = serializeCollection(sample());
    expect(text).not.toMatch(/pathParams: \{\}/);
    expect(text).not.toMatch(/query: \{\}/);
    expect(text).toMatch(/body: \|/);
    expect(text).toMatch(/target: mock/);
    expect(text).toMatch(/target: local-mock/);
    expect(text).toMatch(/server: https:\/\/staging\.example\.com\/v1/);
  });

  it("keeps stopOnFailure off when it was turned off", () => {
    const { text } = serializeCollection({ ...sample(), stopOnFailure: false });
    expect(text).toMatch(/stopOnFailure: false/);
    expect(parseCollection(text).stopOnFailure).toBe(false);
  });

  it("refuses a file from a newer Studio, and one with no version", () => {
    expect(() => parseCollection("version: 2\nname: x\n")).toThrow(/format version 2/);
    expect(() => parseCollection("name: x\n")).toThrow(CollectionFormatError);
    expect(() => parseCollection("- not a map")).toThrow(/YAML map/);
    expect(() => parseCollection("version: [")).toThrow(/valid YAML/);
  });

  it("refuses duplicate and malformed step keys and unknown APIs", () => {
    const base = "version: 1\nname: x\napis:\n  a: { title: A, url: 'https://x.test/a.yaml' }\nsteps:\n";
    expect(() =>
      parseCollection(`${base}  - { key: one, api: a, method: GET, path: / }\n  - { key: one, api: a, method: GET, path: / }\n`),
    ).toThrow(/share the key "one"/);
    expect(() => parseCollection(`${base}  - { key: "1abc", api: a, method: GET, path: / }\n`)).toThrow(/needs a key/);
    expect(() => parseCollection(`${base}  - { key: one, api: b, method: GET, path: / }\n`)).toThrow(/"b"/);
    expect(() => parseCollection(`${base}  - { key: one, method: GET }\n`)).toThrow(/needs a url/);
    expect(() => parseCollection(`${base}  - { key: one, api: a, method: GET, path: /, target: elsewhere }\n`)).toThrow(
      /target must be/,
    );
  });

  it("writes spec paths relative to the collection file and resolves them on reading", () => {
    const { text } = serializeCollection(sample(), { filePath: "/repo/flows/checkout.spec0-collection.yaml" });
    expect(text).toMatch(/file: \.\.\/specs\/orders\.yaml/);
    const parsed = parseCollection(text, { filePath: "/elsewhere/clone/flows/checkout.spec0-collection.yaml" });
    expect(parsed.apis.orders.source).toEqual({ kind: "file", ref: "/elsewhere/clone/specs/orders.yaml" });
  });
});

describe("secrets never reach a collection file", () => {
  it("replaces known secret values with their references", () => {
    setKnownSecrets([
      { id: "e", name: "Staging", variables: [{ name: "token", value: "sk_live_123", secret: true }] },
    ]);
    const collection = sample();
    collection.steps[0].headers = { Authorization: "Bearer sk_live_123" };
    collection.steps[2].queryParams = { key: "sk_live_123" };
    collection.steps[0].body = '{"token":"sk_live_123"}';
    const { text } = serializeCollection(collection);
    expect(text).not.toContain("sk_live_123");
    expect(text).toContain("Bearer {{token}}");
  });

  it("leaves out a literal auth value and says so", () => {
    const collection = sample();
    collection.steps[0].auth = { scheme: "bearerAuth", value: "a-pasted-token" };
    const { text, warnings } = serializeCollection(collection);
    expect(text).not.toContain("a-pasted-token");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/createOrder/);
  });

  it("keeps an auth value that refers to a variable", () => {
    const collection = sample();
    collection.steps[0].auth = { scheme: "__basic", value: "alice:{{password}}" };
    expect(serializeCollection(collection).text).toContain("alice:{{password}}");
  });
});

describe("paths", () => {
  it("works out relative paths", () => {
    expect(relativePath("/repo/flows", "/repo/specs/orders.yaml")).toBe("../specs/orders.yaml");
    expect(relativePath("/repo", "/repo/orders.yaml")).toBe("./orders.yaml");
    expect(relativePath("C:\\work\\flows", "C:\\work\\specs\\o.yaml")).toBe("../specs/o.yaml");
    expect(relativePath("C:\\work", "D:\\specs\\o.yaml")).toBeNull();
    expect(relativePath("/repo", "orders.yaml")).toBeNull();
  });

  it("resolves relative paths against a folder", () => {
    expect(resolvePath("/repo/flows", "../specs/orders.yaml")).toBe("/repo/specs/orders.yaml");
    expect(resolvePath("/repo/flows", "./orders.yaml")).toBe("/repo/flows/orders.yaml");
    expect(resolvePath("C:\\work\\flows", "../specs/o.yaml")).toBe("C:\\work\\specs\\o.yaml");
    expect(resolvePath("/repo", "/abs/o.yaml")).toBe("/abs/o.yaml");
    expect(dirOf("/repo/flows/x.spec0-collection.yaml")).toBe("/repo/flows");
  });
});

describe("step keys and editing", () => {
  it("makes keys from the operation id or the method and path", () => {
    expect(baseStepKey({ operationId: "createOrder", method: "POST", path: "/orders" })).toBe("createOrder");
    expect(baseStepKey({ method: "GET", path: "/orders/{orderId}" })).toBe("getOrdersOrderid");
    expect(baseStepKey({ operationId: "orders.list", method: "GET", path: "/" })).toBe("orderslist");
    expect(uniqueStepKey("createOrder", ["createOrder", "createOrder2"])).toBe("createOrder3");
  });

  it("moves steps", () => {
    const moved = moveStep(sample(), 0, 2);
    expect(moved.steps.map((s) => s.key)).toEqual(["pay", "getOrder", "createOrder", "local", "health"]);
    expect(moveStep(sample(), 1, -5).steps[0].key).toBe("pay");
  });

  it("renames a step and every reference to it", () => {
    const renamed = renameStepKey(sample(), "createOrder", "newOrder");
    expect(renamed.steps[0].key).toBe("newOrder");
    expect(renamed.steps[2].pathParams.orderId).toBe("{{steps.newOrder.body.id}}");
    const form = renamed.steps[1].body as { kind: "form"; fields: Array<{ value: string }> };
    expect(form.fields[0].value).toBe("{{steps.newOrder.body.id}}");
    expect(() => renameStepKey(sample(), "pay", "getOrder")).toThrow(/already/);
    expect(() => renameStepKey(sample(), "pay", "9x")).toThrow();
  });

  it("does not rename a reference to a step whose key only starts the same", () => {
    const collection = sample();
    collection.steps[2].pathParams.orderId = "{{steps.createOrderAgain.body.id}}";
    expect(renameStepKey(collection, "createOrder", "x").steps[2].pathParams.orderId).toBe(
      "{{steps.createOrderAgain.body.id}}",
    );
  });

  it("suggests a file name", () => {
    expect(suggestedCollectionFileName("Checkout flow!")).toBe("checkout-flow.spec0-collection.yaml");
  });
});
