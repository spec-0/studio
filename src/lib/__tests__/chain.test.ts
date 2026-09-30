import { describe, expect, it } from "vitest";
import {
  fieldsFromOutput,
  fieldsFromSchema,
  parsePath,
  referenceFor,
  referencedSteps,
  resolveStepRefs,
  type StepOutput,
} from "../chain";
import { parseSpec } from "../spec";
import { SAMPLE_SPEC } from "../sample";

const created: StepOutput = {
  status: 201,
  headers: { "Content-Type": "application/json", Location: "/orders/o_1" },
  json: { id: "o_1", total: { amount: 1999, currency: "EUR" }, lineItems: [{ sku: "abc" }, { sku: "def" }], paid: false, note: null },
  text: "",
};

const context = (outputs: Record<string, StepOutput> = { createOrder: created }) => ({
  keys: ["createOrder", "pay", "getOrder"],
  outputs: new Map(Object.entries(outputs)),
});

describe("step references", () => {
  it("fills in body fields, nested fields and array items", () => {
    const { text, errors } = resolveStepRefs(
      "/orders/{{steps.createOrder.body.id}}?amt={{ steps.createOrder.body.total.amount }}&sku={{steps.createOrder.body.lineItems[1].sku}}&first={{steps.createOrder.body.lineItems.0.sku}}",
      context(),
    );
    expect(errors).toEqual([]);
    expect(text).toBe("/orders/o_1?amt=1999&sku=def&first=abc");
  });

  it("fills in the status and headers, case-insensitively", () => {
    const { text } = resolveStepRefs("{{steps.createOrder.status}} {{steps.createOrder.headers.location}}", context());
    expect(text).toBe("201 /orders/o_1");
  });

  it("writes booleans, nulls and objects as JSON", () => {
    const { text } = resolveStepRefs(
      '{"paid": {{steps.createOrder.body.paid}}, "note": {{steps.createOrder.body.note}}, "total": {{steps.createOrder.body.total}}}',
      context(),
    );
    expect(JSON.parse(text)).toEqual({ paid: false, note: null, total: { amount: 1999, currency: "EUR" } });
  });

  it("leaves environment variables alone", () => {
    expect(resolveStepRefs("Bearer {{token}}", context()).text).toBe("Bearer {{token}}");
  });

  it("explains every reference it can't fill", () => {
    const cases: Array<[string, RegExp]> = [
      ["{{steps.nope.body.id}}", /no step called "nope"/],
      ["{{steps.pay.body.id}}", /hasn't run yet/],
      ["{{steps.createOrder.body.missing}}", /body\.missing: not in the response/],
      ["{{steps.createOrder.body.lineItems[5].sku}}", /has 2 items/],
      ["{{steps.createOrder.body.lineItems.first}}", /use an index/],
      ["{{steps.createOrder.body.id.deeper}}", /no field here/],
      ["{{steps.createOrder.headers.x-missing}}", /no such header/],
      ["{{steps.createOrder.status.code}}", /has no fields/],
      ["{{steps.createOrder.cookies.a}}", /continue with \.status, \.headers or \.body/],
      ["{{steps.createOrder}}", /say which part/],
    ];
    for (const [input, message] of cases) {
      const { text, errors } = resolveStepRefs(input, context());
      expect(errors, input).toHaveLength(1);
      expect(errors[0], input).toMatch(message);
      expect(text).toBe(input);
    }
  });

  it("says when a body isn't JSON, and offers it whole as text", () => {
    const plain = { status: 200, headers: {}, text: "pong" };
    expect(resolveStepRefs("{{steps.createOrder.body.x}}", context({ createOrder: plain })).errors[0]).toMatch(
      /isn't JSON/,
    );
    expect(resolveStepRefs("{{steps.createOrder.body}}", context({ createOrder: plain })).text).toBe("pong");
  });

  it("parses paths and writes references", () => {
    expect(parsePath(".body.items[0].id")).toEqual(["body", "items", 0, "id"]);
    expect(referenceFor("createOrder", ["body", "items", 0, "id"])).toBe("{{steps.createOrder.body.items[0].id}}");
    expect(referencedSteps("{{steps.a.body.id}} {{steps.b.status}} {{steps.a.status}} {{x}}")).toEqual(["a", "b"]);
  });
});

describe("picking values", () => {
  it("lists every value in a response, with a reference that resolves to it", () => {
    const fields = fieldsFromOutput("createOrder", created);
    const refs = fields.map((f) => f.reference);
    expect(refs).toContain("{{steps.createOrder.status}}");
    expect(refs).toContain("{{steps.createOrder.body.total.amount}}");
    expect(refs).toContain("{{steps.createOrder.body.lineItems[1].sku}}");
    expect(refs).toContain("{{steps.createOrder.headers.Location}}");
    for (const field of fields) {
      const { errors } = resolveStepRefs(field.reference, context());
      expect(errors, field.reference).toEqual([]);
    }
  });

  it("lists a response schema's fields before the step has run", () => {
    const spec = parseSpec(SAMPLE_SPEC, "sample");
    const op = spec.operations.find((o) => o.operationId === "createOrder")!;
    const schema = op.responses.find((r) => r.status === "201")!.schema;
    const refs = fieldsFromSchema("createOrder", spec.doc, schema).map((f) => f.reference);
    expect(refs).toContain("{{steps.createOrder.body.id}}");
    expect(refs).toContain("{{steps.createOrder.body.customer.email}}");
    expect(refs).toContain("{{steps.createOrder.body.lineItems[0].sku}}");
    // The Customer → Order → Customer cycle terminates.
    expect(refs.length).toBeLessThan(200);
  });
});
