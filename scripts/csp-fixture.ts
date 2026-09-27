/**
 * Exercised by `scripts/csp-check.mjs` inside a browser running the app's real
 * content security policy. Kept deliberately small: it must fail for one reason
 * only — that something in the validation path, or in opening a Swagger 2.0
 * spec, needs eval.
 */
import { validateResponse } from "../src/lib/validate";
import { openapiText, parseSpec, type Json } from "../src/lib/spec";

const doc = {
  openapi: "3.0.3",
  components: {
    schemas: {
      Customer: {
        type: "object",
        required: ["email"],
        properties: { email: { type: "string" } },
      },
      Order: {
        type: "object",
        required: ["id", "amount", "customer"],
        properties: {
          id: { type: "string" },
          amount: { type: "integer" },
          customer: { $ref: "#/components/schemas/Customer" },
        },
      },
    },
  },
} as unknown as Json;

const schema = (doc as Record<string, any>).components.schemas.Order as Json;

/** Open a Swagger 2.0 YAML spec (converted on the way in) and check a response against it. */
function swagger2() {
  try {
    const spec = parseSpec(
      [
        "swagger: '2.0'",
        "info: {title: Orders, version: '1'}",
        "host: api.example.com",
        "schemes: [https]",
        "paths:",
        "  /orders/{id}:",
        "    get:",
        "      parameters: [{name: id, in: path, required: true, type: string}]",
        "      responses:",
        "        '200': {description: OK, schema: {$ref: '#/definitions/Order'}}",
        "definitions:",
        "  Order: {type: object, required: [id], properties: {id: {type: string}}}",
        "",
      ].join("\n"),
      "orders.yaml",
    );
    const schema = spec.operations[0]?.responses[0]?.schema;
    return {
      converted: spec.converted?.from ?? null,
      operations: spec.operations.length,
      text: openapiText(spec).startsWith("openapi: 3.0.3"),
      validation: validateResponse(spec.doc, schema, { id: 7 }).status,
    };
  } catch (error) {
    return { error: String(error) };
  }
}

(globalThis as Record<string, unknown>).__CSP_CHECK__ = {
  swagger2: swagger2(),
  valid: validateResponse(doc, schema, {
    id: "or_1",
    amount: 500,
    customer: { email: "a@b.c" },
  }),
  invalid: validateResponse(doc, schema, {
    id: 42,
    customer: { nickname: "x" },
    extra: true,
  }),
};
