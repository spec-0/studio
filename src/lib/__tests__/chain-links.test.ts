import { describe, expect, it } from "vitest";
import { fieldsFromSchema, type StepOutput } from "../chain";
import {
  bodyPathLabel,
  changeLinkSource,
  checkLink,
  collectionLinks,
  dependentsOf,
  describeLinkTarget,
  editLink,
  linkableFields,
  linksBrokenByMove,
  linkValue,
  parseBodyPath,
  removeLink,
  scanJsonBody,
  setJsonBodyField,
  setLink,
  stepLinks,
  type SourceFacts,
} from "../chainLinks";
import { duplicateStep, moveStep, parseCollection, renameStepKey, serializeCollection, type Collection, type CollectionStep } from "../collection";
import { removeStep } from "../collectionLink";
import { parseSpec } from "../spec";
import { SAMPLE_SPEC } from "../sample";

const step = (key: string, extra: Partial<CollectionStep> = {}): CollectionStep => ({
  key,
  request: { method: "GET", url: "https://example.com" },
  pathParams: {},
  queryParams: {},
  headers: {},
  ...extra,
});

const flow = (): Collection => ({
  id: "c1",
  name: "Checkout",
  apis: {},
  stopOnFailure: true,
  updatedAt: "",
  steps: [
    step("createOrder", { name: "Create order", body: '{\n  "customerId": "cus_1"\n}' }),
    step("getOrder", {
      name: "Get order",
      pathParams: { orderId: "{{steps.createOrder.body.id}}" },
      headers: { Authorization: "Bearer {{steps.createOrder.body.token}}" },
    }),
    step("pay", {
      name: "Pay",
      body: '{\n  "orderId": "{{steps.createOrder.body.id}}",\n  "amount": {{steps.createOrder.body.total}},\n  "items": [{ "sku": "{{steps.getOrder.body.lineItems[0].sku}}" }]\n}',
    }),
  ],
});

const created: StepOutput = {
  status: 201,
  headers: { Location: "/orders/o_1" },
  json: { id: "o_1", token: "t", total: { amount: 1999, currency: "EUR" } },
  text: "",
};

describe("reading links out of steps", () => {
  it("finds links in parameters, headers and JSON body paths, quoted and bare", () => {
    const links = collectionLinks(flow());
    expect(links.map((l) => [l.targetStep, describeLinkTarget(l.target), l.source.step, l.source.path.join("/"), l.whole, Boolean(l.bare)])).toEqual([
      ["getOrder", "path orderId", "createOrder", "body/id", true, false],
      ["getOrder", "header Authorization", "createOrder", "body/token", false, false],
      ["pay", "body.orderId", "createOrder", "body/id", true, false],
      ["pay", "body.amount", "createOrder", "body/total", true, true],
      ["pay", "body.items[0].sku", "getOrder", "body/lineItems/0/sku", true, false],
    ]);
  });

  it("falls back to the text of a body that isn't JSON", () => {
    const links = stepLinks(step("s", { body: "id={{steps.a.body.id}}&x=1" }), 2);
    expect(links).toHaveLength(1);
    expect(links[0].target).toEqual({ in: "text", where: "body" });
    expect(links[0].whole).toBe(false);
  });

  it("finds links in form fields, the URL and auth", () => {
    const links = stepLinks(
      step("s", {
        request: { method: "GET", url: "https://x/{{steps.a.body.id}}" },
        auth: { scheme: "b", value: "{{steps.login.body.token}}" },
        body: { kind: "form", fields: [{ key: "order", value: "{{steps.a.body.id}}" }] },
      }),
      1,
    );
    expect(links.map((l) => describeLinkTarget(l.target))).toEqual(["form order", "URL", "auth value"]);
  });

  it("reads a body with env variables and bare references as JSON", () => {
    const scan = scanJsonBody('{ "n": {{count}}, "total": {{steps.a.body.total}}, "s": "{{token}}" }');
    expect(scan.ok).toBe(true);
  });
});

describe("writing links", () => {
  it("writes a parameter link as the reference", () => {
    const next = setLink(flow(), 2, { in: "query", name: "order" }, { step: "createOrder", path: ["body", "id"] });
    expect(next.steps[2].queryParams.order).toBe("{{steps.createOrder.body.id}}");
  });

  it("keeps a header's existing spelling", () => {
    const next = setLink(flow(), 1, { in: "header", name: "authorization" }, { step: "createOrder", path: ["headers", "location"] });
    expect(next.steps[1].headers).toEqual({ Authorization: "{{steps.createOrder.headers.location}}" });
  });

  it("writes into a JSON body path, quoted for strings and bare otherwise, keeping the indent", () => {
    let next = setLink(flow(), 0, { in: "body", path: ["note"] }, { step: "x", path: ["body", "n"] });
    expect(next.steps[0].body).toBe('{\n  "customerId": "cus_1",\n  "note": "{{steps.x.body.n}}"\n}');
    next = setLink(next, 2, { in: "body", path: ["items", 1, "qty"] }, { step: "createOrder", path: ["body", "total", "amount"] }, { bare: true });
    const body = next.steps[2].body as string;
    expect(body).toContain('"qty": {{steps.createOrder.body.total.amount}}');
    // The other bare reference is still bare, and the result reads as JSON again.
    expect(body).toContain('"amount": {{steps.createOrder.body.total}}');
    expect(collectionLinks(next).filter((l) => l.targetStep === "pay")).toHaveLength(4);
  });

  it("starts a JSON body when there is none", () => {
    const next = setLink(flow(), 1, { in: "body", path: ["orderId"] }, { step: "createOrder", path: ["body", "id"] });
    expect(JSON.parse(next.steps[1].body as string)).toEqual({ orderId: "{{steps.createOrder.body.id}}" });
  });

  it("refuses to rewrite a body that isn't JSON", () => {
    const c = flow();
    c.steps[2] = { ...c.steps[2], body: "not json" };
    expect(() => setLink(c, 2, { in: "body", path: ["a"] }, { step: "createOrder", path: ["body", "id"] })).toThrow(/isn't valid JSON/);
    expect(setJsonBodyField("{", ["a"], 1)).toHaveProperty("error");
  });

  it("changes where a link's value comes from, in place", () => {
    const c = flow();
    const [pathLink, headerLink] = collectionLinks(c);
    let next = changeLinkSource(c, pathLink, { step: "createOrder", path: ["body", "number"] });
    expect(next.steps[1].pathParams.orderId).toBe("{{steps.createOrder.body.number}}");
    next = changeLinkSource(next, headerLink, { step: "createOrder", path: ["body", "jwt"] });
    expect(next.steps[1].headers.Authorization).toBe("Bearer {{steps.createOrder.body.jwt}}");
  });

  it("changes a body link without touching another field with the same reference", () => {
    const c = setLink(flow(), 2, { in: "body", path: ["copy"] }, { step: "createOrder", path: ["body", "id"] });
    const link = collectionLinks(c).find((l) => l.target.in === "body" && bodyPathLabel(l.target.path) === "copy")!;
    const next = changeLinkSource(c, link, { step: "getOrder", path: ["body", "id"] });
    const scan = scanJsonBody(next.steps[2].body as string);
    expect(scan.ok && (scan.value as Record<string, unknown>).orderId).toBe("{{steps.createOrder.body.id}}");
    expect(scan.ok && (scan.value as Record<string, unknown>).copy).toBe("{{steps.getOrder.body.id}}");
  });

  it("changes a bare body link and keeps it bare", () => {
    const c = flow();
    const amount = collectionLinks(c).find((l) => l.bare)!;
    const next = changeLinkSource(c, amount, { step: "getOrder", path: ["body", "total"] });
    expect(next.steps[2].body).toContain('"amount": {{steps.getOrder.body.total}}');
  });

  it("removes links: blank parameter, header gone, body field back to an example, text taken out", () => {
    const c = flow();
    const links = collectionLinks(c);
    expect(removeLink(c, links[0]).steps[1].pathParams.orderId).toBe("");
    expect(removeLink(c, links[1]).steps[1].headers.Authorization).toBe("Bearer ");
    const whole = setLink(c, 1, { in: "header", name: "X-Order" }, { step: "createOrder", path: ["body", "id"] });
    const headerLink = collectionLinks(whole).find((l) => l.target.in === "header" && l.target.name === "X-Order")!;
    expect(removeLink(whole, headerLink).steps[1].headers).not.toHaveProperty("X-Order");
    const bodyLink = links[2];
    const cleared = removeLink(c, bodyLink, "ord_example");
    expect(JSON.parse(cleared.steps[2].body!.toString().replace(/\{\{steps[^}]*\}\}/g, "0")).orderId).toBe("ord_example");
    const bare = removeLink(c, links[3]);
    expect(bare.steps[2].body).toContain('"amount": null');
    expect(collectionLinks(bare)).toHaveLength(4);
  });

  it("moves a link to another field", () => {
    const c = flow();
    const link = collectionLinks(c)[0];
    const next = editLink(c, link, { targetIndex: 2, target: { in: "query", name: "order" }, source: { step: "getOrder", path: ["body", "id"] } });
    expect(next.steps[1].pathParams.orderId).toBe("");
    expect(next.steps[2].queryParams.order).toBe("{{steps.getOrder.body.id}}");
  });

  it("keeps the file format: links are only references", () => {
    const c = setLink(flow(), 2, { in: "body", path: ["note"] }, { step: "getOrder", path: ["status"] });
    const text = serializeCollection(c).text;
    expect(text).toContain("version: 1");
    const back = parseCollection(text);
    expect(collectionLinks(back).map((l) => l.reference)).toEqual(collectionLinks(c).map((l) => l.reference));
  });
});

describe("broken links", () => {
  const facts = (map: Record<string, SourceFacts>) => (key: string) => map[key];

  it("is fine when the field is in the last response", () => {
    const c = flow();
    expect(checkLink(c, collectionLinks(c)[0], facts({ createOrder: { output: created } }))).toEqual({ state: "ok", basis: "response" });
  });

  it("is broken when the field wasn't in the last response", () => {
    const c = changeLinkSource(flow(), collectionLinks(flow())[0], { step: "createOrder", path: ["body", "nope"] });
    const check = checkLink(c, collectionLinks(c)[0], facts({ createOrder: { output: created } }));
    expect(check.state).toBe("broken");
    expect(check.state === "broken" && check.reason).toMatch(/body\.nope wasn't in Create order's last response/);
  });

  it("is broken when the source step was removed, and names it", () => {
    const c = removeStep(flow(), 0);
    const check = checkLink(c, collectionLinks(c)[0], facts({}));
    expect(check.state === "broken" && check.reason).toMatch(/no step "createOrder"/);
  });

  it("follows a rename instead of breaking", () => {
    const c = renameStepKey(flow(), "createOrder", "newOrder");
    expect(collectionLinks(c).every((l) => l.source.step !== "createOrder")).toBe(true);
    expect(checkLink(c, collectionLinks(c)[0], facts({})).state).not.toBe("broken");
  });

  it("is broken when the source now runs after the target, and offers the move back", () => {
    const c = moveStep(flow(), 0, 2);
    const link = collectionLinks(c).find((l) => l.targetStep === "getOrder")!;
    const check = checkLink(c, link, facts({}));
    expect(check.state).toBe("broken");
    expect(check.state === "broken" && check.fix).toEqual({ kind: "move", from: 2, to: 0 });
    expect(check.state === "broken" && check.reason).toMatch(/Create order \(step 3\) runs after Get order \(step 1\)/);
  });

  it("checks against the declared response before a run, and can't check headers", () => {
    const spec = parseSpec(SAMPLE_SPEC, "Orders");
    const op = spec.operations.find((o) => o.operationId === "createOrder")!;
    const schema = op.responses.find((r) => /^2/.test(r.status) && r.schema)!.schema;
    const schemaFields = fieldsFromSchema("createOrder", spec.doc, schema).map((f) => f.path);
    const c = flow();
    const [pathLink, headerLink] = collectionLinks(c);
    expect(checkLink(c, pathLink, facts({ createOrder: { schemaFields } }))).toEqual({ state: "ok", basis: "schema" });
    expect(checkLink(c, headerLink, facts({ createOrder: { schemaFields } })).state).toBe("unchecked");
    const locationLink = { targetIndex: 1, source: { step: "createOrder", path: ["headers", "location"] } };
    expect(checkLink(c, locationLink, facts({})).state).toBe("unchecked");
  });

  it("warns about a move that would break links, and only those", () => {
    const c = flow();
    expect(linksBrokenByMove(c, 0, 1).map((l) => l.targetStep)).toEqual(["getOrder", "getOrder"]);
    expect(linksBrokenByMove(c, 1, 2).map((l) => describeLinkTarget(l.target))).toEqual(["body.items[0].sku"]);
    expect(linksBrokenByMove(c, 2, 1).map((l) => describeLinkTarget(l.target))).toEqual(["body.items[0].sku"]);
    // A link that's already broken isn't reported again.
    const moved = moveStep(c, 0, 2);
    expect(linksBrokenByMove(moved, 2, 1)).toEqual([]);
  });

  it("names the steps that depend on one being removed", () => {
    const deps = dependentsOf(flow(), 0);
    expect([...new Set(deps.map((l) => l.targetStep))]).toEqual(["getOrder", "pay"]);
    expect(dependentsOf(flow(), 2)).toEqual([]);
  });
});

describe("values after a run", () => {
  it("gives the value a link passed", () => {
    const outputs = new Map([["createOrder", created]]);
    const [pathLink, , , amount] = collectionLinks(flow());
    expect(linkValue(pathLink, outputs)).toBe("o_1");
    expect(linkValue(amount, outputs)).toBe('{"amount":1999,"currency":"EUR"}');
  });

  it("prefers what the run recorded, matched by field and reference", async () => {
    const { passedValue } = await import("../chainLinks");
    const recorded = [
      { target: "path orderId", source: "steps.createOrder.body.id", value: "o_9" },
      { target: "body", source: "steps.createOrder.body.total", value: "{\"amount\":1}" },
      { target: "body", source: "steps.getOrder.body.lineItems[0].sku", error: "not run" },
    ];
    const [pathLink, , , amount, sku] = collectionLinks(flow());
    expect(passedValue(pathLink, recorded)).toBe("o_9");
    expect(passedValue(amount, recorded)).toBe('{"amount":1}');
    expect(passedValue(sku, recorded)).toBeUndefined();
    const { planStep } = await import("../collectionRun");
    const planned = planStep(flow().steps[1], {
      op: null,
      baseUrl: "",
      vars: {},
      keys: ["createOrder", "getOrder", "pay"],
      outputs: new Map([["createOrder", created]]),
      auth: null,
    });
    // The run's own records line up with the links read from the step.
    expect(passedValue(collectionLinks(flow())[0], planned.links ?? [])).toBe("o_1");
  });
});

describe("fields a link can fill", () => {
  const spec = parseSpec(SAMPLE_SPEC, "Orders");
  it("lists parameters, headers and body fields from the spec and the body", () => {
    const op = spec.operations.find((o) => o.operationId === "createOrder")!;
    const fields = linkableFields(step("createOrder", { body: '{ "customerId": "x", "extra": 1 }' }), op, spec.doc);
    const labels = fields.map((f) => `${f.group}:${f.label}`);
    expect(labels).toContain("Body fields:customerId");
    expect(labels).toContain("Body fields:extra");
    expect(fields.find((f) => f.label === "extra")?.bare).toBe(true);
    expect(fields.find((f) => f.label === "customerId")?.bare).toBe(false);
    const get = spec.operations.find((o) => o.operationId === "getOrder")!;
    expect(linkableFields(step("g"), get, spec.doc).map((f) => `${f.group}:${f.label}`)).toContain("Path parameters:orderId");
  });

  it("parses a typed body path", () => {
    expect(parseBodyPath("body.items[0].sku")).toEqual(["items", 0, "sku"]);
    expect(parseBodyPath("orderId")).toEqual(["orderId"]);
    expect(parseBodyPath("a b")).toBeNull();
  });
});

describe("editing steps", () => {
  it("duplicates a step after itself with a new key", () => {
    const c = duplicateStep(flow(), 1);
    expect(c.steps.map((s) => s.key)).toEqual(["createOrder", "getOrder", "getOrder2", "pay"]);
    expect(c.steps[2].name).toBe("Get order (copy)");
    expect(c.steps[2].pathParams).toEqual(c.steps[1].pathParams);
  });
});

describe("the whole chain", () => {
  it("checks every link and carries the last values", async () => {
    const { analyseChain } = await import("../chainLinks");
    const views = analyseChain(flow(), (key) => (key === "createOrder" ? { output: created } : undefined), new Map([["createOrder", created]]));
    expect(views.map((v) => [v.id.split("|").slice(1, 2)[0], v.check.state, v.value ?? "-"])).toEqual([
      ["path:orderId", "ok", "o_1"],
      ["header:Authorization", "ok", "t"],
      ["body:orderId", "ok", "o_1"],
      ["body:amount", "ok", '{"amount":1999,"currency":"EUR"}'],
      ["body:items[0].sku", "unchecked", "-"],
    ]);
    expect(new Set(views.map((v) => v.id)).size).toBe(views.length);
  });
});
