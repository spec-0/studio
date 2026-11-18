/**
 * Parameter examples.
 *
 * An OpenAPI Parameter Object has its own `example` and `examples`, and they
 * come before its schema's. A request built only from the schema was sent as
 * `/payments/string` although the spec said `pay_8Hq2`.
 */

import { describe, expect, it } from "vitest";
import { seedEditor } from "../editor";
import { exampleFor, exampleParam } from "../example";
import { parseSpec } from "../spec";

const SPEC = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Payments", version: "1" },
  components: { examples: { card: { value: "card" } } },
  paths: {
    "/payments/{paymentId}": {
      get: {
        operationId: "getPayment",
        parameters: [
          { name: "paymentId", in: "path", required: true, example: "pay_8Hq2", schema: { type: "string" } },
          { name: "method", in: "query", required: true, examples: { first: { $ref: "#/components/examples/card" } }, schema: { type: "string" } },
          { name: "limit", in: "query", required: true, schema: { type: "integer", example: 20 } },
          { name: "cursor", in: "query", required: true, schema: { type: "string" } },
        ],
        responses: { "200": { description: "ok" } },
      },
    },
  },
});

const spec = parseSpec(SPEC, "payments.json");
const op = spec.operations[0];
const param = (name: string) => op.parameters.find((p) => p.name === name)!;

describe("exampleParam", () => {
  it("uses the parameter's own example before its schema", () => {
    expect(exampleParam(spec.doc, param("paymentId"))).toBe("pay_8Hq2");
  });

  it("uses the first of the parameter's examples, following a $ref", () => {
    expect(exampleParam(spec.doc, param("method"))).toBe("card");
  });

  it("falls back to the schema's example, then to a value built from the schema", () => {
    expect(exampleParam(spec.doc, param("limit"))).toBe("20");
    expect(exampleParam(spec.doc, param("cursor"))).toBe("string");
  });

  it("seeds the request editor with them", () => {
    const state = seedEditor(spec, op, null, false);
    expect(state.pathParams).toEqual({ paymentId: "pay_8Hq2" });
    expect(state.queryParams).toMatchObject({ method: "card", limit: "20" });
  });
});

describe("values guessed from a property's name", () => {
  const SEARCH = JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Search", version: "1" },
    paths: {},
    components: {
      schemas: {
        Result: {
          type: "object",
          properties: {
            apiName: { type: "string" },
            teamName: { type: "string" },
            name: { type: "string" },
            version: { type: "string" },
            specVersion: { type: "string" },
            score: { type: "number" },
            method: { type: "string" },
            path: { type: "string" },
            operationId: { type: "string" },
            status: { type: "string" },
            ownerId: { type: "string" },
          },
        },
        Customer: {
          type: "object",
          properties: { name: { type: "string" }, firstName: { type: "string" }, lastName: { type: "string" } },
        },
      },
    },
  });
  const doc = parseSpec(SEARCH, "search.json").doc;
  const example = (name: string) => exampleFor(doc, { $ref: `#/components/schemas/${name}` }, "body", "response");

  it("doesn't call an API or a team Ada Lovelace", () => {
    expect(example("Result")).toEqual({
      apiName: "orders-api",
      teamName: "Payments",
      name: "example-name",
      version: "1.0.0",
      specVersion: "1.0.0",
      score: 0.82,
      method: "GET",
      path: "/orders",
      operationId: "listOrders",
      status: "active",
      ownerId: "id_7f3a92c1",
    });
  });

  it("keeps a person's name for a person", () => {
    expect(example("Customer")).toEqual({ name: "Ada Lovelace", firstName: "Ada", lastName: "Lovelace" });
  });
});
