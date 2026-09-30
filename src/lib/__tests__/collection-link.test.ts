import { describe, expect, it } from "vitest";
import { newCollection, type Collection, type CollectionStep } from "../collection";
import {
  addOperationStep,
  findLibraryEntry,
  linkStep,
  relinkStep,
  removeStep,
  resolveTarget,
  stepValuesFromHistory,
  targetFromAddress,
  targetOptions,
} from "../collectionLink";
import type { LibraryEntry } from "../library";
import { SAMPLE_SPEC } from "../sample";
import { parseSpec, type ParsedSpec } from "../spec";

function entry(id: string, title: string, source: LibraryEntry["source"], extra: Partial<LibraryEntry> = {}): LibraryEntry {
  return {
    id,
    title,
    version: "1",
    source,
    operations: 0,
    schemas: 0,
    addedAt: "",
    openedAt: "",
    ...extra,
  };
}

const sample = parseSpec(SAMPLE_SPEC, "sample");
const sampleEntry = entry("sample_1", "Orders API (sample)", { kind: "sample", ref: "sample" });

/** The sample spec, changed the way a spec changes between releases. */
function changedSample(): ParsedSpec {
  const text = SAMPLE_SPEC
    // getOrder moves.
    .replace("  /orders/{orderId}:\n    get:\n      operationId: getOrder", "  /v2/orders/{orderId}:\n    get:\n      operationId: getOrder")
    // listOrders loses `cursor` and gains a required `tenant`.
    .replace(
      "        - name: cursor\n          in: query\n          schema: { type: string }",
      "        - name: tenant\n          in: header\n          required: true\n          schema: { type: string }",
    )
    // NewOrder now requires a currency.
    .replace("required: [customerId, lineItems]", "required: [customerId, lineItems, currency]")
    // getCustomer is removed and its path is gone.
    .replace(/  \/customers\/\{customerId\}:[\s\S]*?(?=components:)/, "");
  return parseSpec(text, "sample");
}

function build(): Collection {
  let collection = newCollection("Flow");
  const op = (id: string) => sample.operations.find((o) => o.operationId === id)!;
  collection = addOperationStep(collection, sampleEntry, sample, op("createOrder"));
  collection = addOperationStep(collection, sampleEntry, sample, op("getOrder"), {
    pathParams: { orderId: "{{steps.createOrder.body.id}}" },
  });
  collection = addOperationStep(collection, sampleEntry, sample, op("listOrders"), { queryParams: { cursor: "abc" } });
  collection = addOperationStep(collection, sampleEntry, sample, op("getCustomer"));
  return collection;
}

describe("finding a step's API in the library", () => {
  const entries = [
    entry("f1", "Orders API", { kind: "file", ref: "/repo/specs/orders.yaml" }),
    entry("f2", "Payments API", { kind: "file", ref: "payments.yaml" }),
    entry("u1", "Catalog", { kind: "url", ref: "https://example.com/catalog.yaml" }),
    entry("s1", "Billing", { kind: "file", ref: "/x/billing.yaml" }, { spec0ApiId: "api_9" }),
    entry("t1", "Same title", { kind: "url", ref: "https://a.test/one.yaml" }),
  ];

  it("matches the same source first", () => {
    expect(findLibraryEntry({ title: "x", source: { kind: "file", ref: "/repo/specs/orders.yaml" } }, entries)?.id).toBe("f1");
    expect(findLibraryEntry({ title: "x", source: { kind: "url", ref: "https://example.com/catalog.yaml" } }, entries)?.id).toBe("u1");
  });

  it("matches a Spec0 API by its id", () => {
    expect(findLibraryEntry({ title: "x", source: { kind: "spec0", ref: "spec0:api_9" } }, entries)?.id).toBe("s1");
    expect(findLibraryEntry({ title: "x", source: { kind: "url", ref: "https://gone" }, spec0ApiId: "api_9" }, entries)?.id).toBe("s1");
  });

  it("matches a dragged-in file by its name and title together", () => {
    expect(findLibraryEntry({ title: "Payments API", source: { kind: "file", ref: "/other/machine/payments.yaml" } }, entries)?.id).toBe("f2");
    expect(findLibraryEntry({ title: "Something else", source: { kind: "file", ref: "/other/payments.yaml" } }, entries)).toBeNull();
  });

  it("never matches on a title alone", () => {
    expect(findLibraryEntry({ title: "Same title", source: { kind: "url", ref: "https://b.test/two.yaml" } }, entries)).toBeNull();
  });
});

describe("linking steps to the spec as it is now", () => {
  const specs = (spec: ParsedSpec) => new Map([[sampleEntry.id, spec]]);

  it("finds every step's operation in an unchanged spec", () => {
    const collection = build();
    const links = collection.steps.map((step) => linkStep(step, collection, [sampleEntry], specs(sample)));
    // `cursor` was given a value by hand, and the spec declares it, so all is well.
    expect(links.map((l) => l.kind)).toEqual(["ok", "ok", "ok", "ok"]);
  });

  it("marks what changed, in words", () => {
    const collection = build();
    const changed = changedSample();
    const [create, get, list, customer] = collection.steps.map((step) =>
      linkStep(step, collection, [sampleEntry], specs(changed)),
    );
    expect(create.kind).toBe("stale");
    expect(create.kind === "stale" && create.reasons.join(" ")).toMatch(/`currency`/);
    expect(get.kind === "stale" && get.reasons.join(" ")).toMatch(/getOrder is now GET \/v2\/orders\/\{orderId\} \(was GET \/orders\/\{orderId\}\)/);
    expect(list.kind === "stale" && list.reasons.join(" ")).toMatch(/query parameter cursor is no longer in the spec/);
    expect(list.kind === "stale" && list.reasons.join(" ")).toMatch(/requires the header parameter tenant/);
    expect(customer.kind).toBe("unresolved");
    expect(customer.kind === "unresolved" && customer.reason).toMatch(/getCustomer is no longer in Orders API/);
  });

  it("falls back to method and path when the operation id changed", () => {
    const collection = build();
    const renamed = parseSpec(SAMPLE_SPEC.replace("operationId: createOrder", "operationId: placeOrder"), "sample");
    const link = linkStep(collection.steps[0], collection, [sampleEntry], specs(renamed));
    expect(link.kind).toBe("stale");
    expect(link.kind === "stale" && link.reasons[0]).toMatch(/changed from createOrder to placeOrder/);
  });

  it("says when the API isn't in the library, and waits for a spec that is still loading", () => {
    const collection = build();
    expect(linkStep(collection.steps[0], collection, [], new Map()).kind).toBe("unresolved");
    expect(linkStep(collection.steps[0], collection, [sampleEntry], new Map()).kind).toBe("loading");
    const raw: CollectionStep = { key: "raw", request: { method: "GET", url: "https://x.test" }, pathParams: {}, queryParams: {}, headers: {} };
    expect(linkStep(raw, collection, [sampleEntry], specs(sample)).kind).toBe("unlinked");
  });

  it("notices a target server the spec no longer declares", () => {
    const collection = build();
    const step = { ...collection.steps[0], target: { kind: "server" as const, url: "https://old.example.com" } };
    const link = linkStep(step, collection, [sampleEntry], specs(sample));
    expect(link.kind === "stale" && link.reasons[0]).toMatch(/no longer declares the server/);
  });
});

describe("making and relinking steps", () => {
  it("adds one API entry per spec and unique step keys", () => {
    let collection = build();
    const op = sample.operations.find((o) => o.operationId === "createOrder")!;
    collection = addOperationStep(collection, sampleEntry, sample, op);
    expect(Object.keys(collection.apis)).toEqual(["orders"]);
    expect(collection.steps.map((s) => s.key)).toEqual(["createOrder", "getOrder", "listOrders", "getCustomer", "createOrder2"]);
    // Required values start from the schema, as the editor does.
    expect(collection.steps[3].pathParams.customerId).toBeTruthy();
    expect(typeof collection.steps[0].body).toBe("string");
  });

  it("links a step whose operation disappeared to another one, keeping its inputs", () => {
    const collection = build();
    const op = sample.operations.find((o) => o.operationId === "getOrder")!;
    const relinked = relinkStep(collection, 3, sampleEntry, op);
    expect(relinked.steps[3].key).toBe("getCustomer");
    expect(relinked.steps[3].operation).toEqual({ operationId: "getOrder", method: "GET", path: "/orders/{orderId}" });
    // customerId isn't a parameter of getOrder, so it is dropped rather than marked stale.
    expect(relinked.steps[3].pathParams).toEqual({});
  });

  it("links an unlinked request, reading path values from its URL", () => {
    let collection = newCollection("Imported");
    collection = {
      ...collection,
      steps: [
        {
          key: "fetch",
          request: { method: "GET", url: "{{baseUrl}}/orders/o_77?expand=customer" },
          pathParams: {},
          queryParams: {},
          headers: { "X-Trace": "1" },
        },
      ],
    };
    const op = sample.operations.find((o) => o.operationId === "getOrder")!;
    const linked = relinkStep(collection, 0, sampleEntry, op);
    expect(linked.steps[0].api).toBe("orders");
    expect(linked.steps[0].pathParams).toEqual({ orderId: "o_77" });
    expect(linked.steps[0].headers).toEqual({ "X-Trace": "1" });
    expect(linked.steps[0].request).toBeUndefined();
  });

  it("drops an API when its last step is removed", () => {
    let collection = build();
    for (let i = collection.steps.length - 1; i >= 0; i -= 1) collection = removeStep(collection, i);
    expect(collection.apis).toEqual({});
  });

  it("keeps the values a recorded request was sent with, minus the headers Studio manages", () => {
    const op = sample.operations.find((o) => o.operationId === "getOrder")!;
    const values = stepValuesFromHistory(
      {
        url: "https://api.example.com/v1/orders/o_1?expand=customer&api_key={{key}}",
        headers: { Accept: "application/json", "X-Mock-API-Key": "{{mockKey}}", "X-Trace": "t1", Authorization: "Bearer {{token}}" },
      },
      op,
    );
    expect(values.pathParams).toEqual({ orderId: "o_1" });
    expect(values.queryParams).toEqual({});
    expect(values.headers).toEqual({ "X-Trace": "t1", Authorization: "Bearer {{token}}" });
  });
});

describe("targets", () => {
  it("offers the spec's servers and the mock", () => {
    expect(targetOptions(sample, "https://mock.test").map((o) => o.label)).toEqual([
      "https://api.example.com/v1",
      "https://staging.api.example.com/v1",
      "Hosted mock",
    ]);
    expect(targetOptions(sample, null)).toHaveLength(2);
  });

  it("resolves every kind of target, and says why one can't be used", () => {
    const context = { servers: sample.servers, mockUrl: "https://mock.test/m" };
    expect(resolveTarget(undefined, context)).toEqual({ url: "https://api.example.com/v1", mock: false });
    expect(resolveTarget({ kind: "mock" }, context)).toEqual({ url: "https://mock.test/m", mock: true });
    expect(resolveTarget({ kind: "custom", url: "http://localhost:1" }, context)).toEqual({ url: "http://localhost:1", mock: false });
    expect(resolveTarget({ kind: "mock" }, { ...context, mockUrl: null })).toHaveProperty("error");
    expect(resolveTarget({ kind: "local-mock" }, context)).toHaveProperty("error");
    expect(resolveTarget({ kind: "local-mock" }, { ...context, localMockUrl: "http://127.0.0.1:4010" })).toEqual({
      url: "http://127.0.0.1:4010",
      mock: true,
    });
    expect(resolveTarget(undefined, { servers: [], mockUrl: null })).toHaveProperty("error");
  });

  it("takes a new step's target from the address bar it was added from", () => {
    expect(targetFromAddress("https://api.example.com/v1", sample, null)).toBeUndefined();
    expect(targetFromAddress("https://staging.api.example.com/v1/", sample, null)).toEqual({
      kind: "server",
      url: "https://staging.api.example.com/v1",
    });
    expect(targetFromAddress("https://mock.test", sample, "https://mock.test")).toEqual({ kind: "mock" });
    expect(targetFromAddress("{{baseUrl}}", sample, null)).toEqual({ kind: "custom", url: "{{baseUrl}}" });
  });
});
