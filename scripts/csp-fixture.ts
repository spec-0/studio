/**
 * Exercised by `scripts/csp-check.mjs` inside a browser running the app's real
 * content security policy. Kept deliberately small: it must fail for one reason
 * only — that something in the validation path needs eval.
 */
import { validateResponse } from "../src/lib/validate";
import type { Json } from "../src/lib/spec";

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

(globalThis as Record<string, unknown>).__CSP_CHECK__ = {
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
