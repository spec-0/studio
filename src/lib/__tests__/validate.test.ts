/**
 * Response validation.
 *
 * These exist because the feature shipped broken and nothing noticed. The
 * webview's content security policy forbids `new Function`, Ajv compiles
 * schemas with exactly that, and so every response in the released build came
 * back `Couldn't validate` followed by several hundred characters of CSP text.
 * The claim "responses are checked against the contract" was false for two
 * weeks.
 *
 * A unit test would not have caught it on its own — Node has no CSP, so Ajv
 * compiles happily here. The guard at the bottom is the part that would have,
 * and it is the reason this file is worth more than its coverage number.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { validateResponse, type Finding } from "../validate";
import type { Json } from "../spec";

const doc: Json = {
  openapi: "3.0.3",
  components: {
    schemas: {
      Customer: {
        type: "object",
        required: ["email"],
        properties: { email: { type: "string" }, nickname: { type: "string" } },
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
};

const orderSchema = doc.components.schemas.Order as Json;
const paths = (findings: Finding[]) => findings.map((f) => f.path).sort();

describe("a response that matches its schema", () => {
  it("passes", () => {
    const result = validateResponse(doc, orderSchema, {
      id: "or_1",
      amount: 500,
      customer: { email: "a@b.c" },
    });
    expect(result.status).toBe("ok");
    expect(result.findings).toEqual([]);
  });

  // The bug this whole file exists for: the status was "error" for every
  // response, valid or not, because the validator could not be constructed.
  it("is never reported as an internal error", () => {
    const result = validateResponse(doc, orderSchema, {
      id: "or_1",
      amount: 500,
      customer: { email: "a@b.c" },
    });
    expect(result.status).not.toBe("error");
    expect(result.note).toBeUndefined();
  });
});

describe("what the schema forbids", () => {
  it("names a missing required field, and where it should have been", () => {
    const result = validateResponse(doc, orderSchema, { id: "or_1", customer: { email: "a@b.c" } });
    expect(result.status).toBe("mismatch");
    const missing = result.findings.filter((f) => f.kind === "missing_required");
    expect(missing).toHaveLength(1);
    expect(missing[0].path).toBe("$.amount");
    expect(missing[0].message).toContain("amount");
  });

  it("reports a required field missing from a nested object at its own path", () => {
    const result = validateResponse(doc, orderSchema, {
      id: "or_1",
      amount: 500,
      customer: { nickname: "no email" },
    });
    const missing = result.findings.filter((f) => f.kind === "missing_required");
    expect(missing.map((f) => f.path)).toContain("$.customer.email");
  });

  it("reports a wrong type at the field, not at the root", () => {
    const result = validateResponse(doc, orderSchema, {
      id: 42,
      amount: 500,
      customer: { email: "a@b.c" },
    });
    const types = result.findings.filter((f) => f.kind === "type_mismatch");
    expect(types).toHaveLength(1);
    expect(types[0].path).toBe("$.id");
    expect(types[0].message).toContain("string");
  });

  // The validator reports the whole chain — a bad field arrives as `type`, and
  // again as `properties`, and again as `$ref`. Reporting all three lists one
  // problem three times and buries the line that says what is wrong.
  it("reports one finding per problem, not one per schema layer", () => {
    const result = validateResponse(doc, orderSchema, {
      id: 42,
      amount: 500,
      customer: { email: "a@b.c" },
    });
    expect(result.findings).toHaveLength(1);
  });

  it("still reports something when every error is a wrapper", () => {
    // `not` fails on its own with nothing specific underneath it.
    const schema: Json = { not: { type: "object" } };
    const result = validateResponse(doc, schema, { anything: true });
    expect(result.status).toBe("mismatch");
    expect(result.findings.length).toBeGreaterThan(0);
  });
});

describe("what the schema never mentioned", () => {
  // Specs almost never set `additionalProperties: false`, so a validator alone
  // stays silent on exactly the drift a developer most wants to see.
  it("reports an undeclared field", () => {
    const result = validateResponse(doc, orderSchema, {
      id: "or_1",
      amount: 500,
      customer: { email: "a@b.c" },
      surprise: "added by the server",
    });
    expect(result.status).toBe("mismatch");
    expect(paths(result.findings)).toContain("$.surprise");
    expect(result.findings.find((f) => f.path === "$.surprise")?.kind).toBe("extra_field");
  });

  it("reports an undeclared field nested inside a referenced schema", () => {
    const result = validateResponse(doc, orderSchema, {
      id: "or_1",
      amount: 500,
      customer: { email: "a@b.c", loyaltyTier: "gold" },
    });
    expect(paths(result.findings)).toContain("$.customer.loyaltyTier");
  });
});

describe("the OpenAPI 3.0 dialect", () => {
  it("accepts null for a nullable field", () => {
    const schema: Json = {
      type: "object",
      properties: { note: { type: "string", nullable: true } },
    };
    expect(validateResponse(doc, schema, { note: null }).status).toBe("ok");
  });

  it("ignores annotation-only keywords rather than choking on them", () => {
    const schema: Json = {
      type: "object",
      properties: { id: { type: "string", example: "or_1", deprecated: true } },
      xml: { name: "order" },
      externalDocs: { url: "https://example.test" },
    };
    expect(validateResponse(doc, schema, { id: "or_1" }).status).toBe("ok");
  });

  it("survives draft-4 boolean exclusiveMinimum", () => {
    const schema: Json = {
      type: "object",
      properties: { amount: { type: "integer", minimum: 0, exclusiveMinimum: true } },
    };
    expect(validateResponse(doc, schema, { amount: 5 }).status).not.toBe("error");
  });
});

describe("when there is nothing to check against", () => {
  it("says so rather than claiming a pass", () => {
    expect(validateResponse(doc, undefined, { a: 1 }).status).toBe("no_schema");
  });

  it("says so when the body isn't JSON", () => {
    expect(validateResponse(doc, orderSchema, undefined).status).toBe("no_schema");
  });
});

describe("a recursive schema", () => {
  it("terminates instead of hanging", () => {
    const recursive: Json = {
      openapi: "3.0.3",
      components: {
        schemas: {
          Node: {
            type: "object",
            properties: { child: { $ref: "#/components/schemas/Node" } },
          },
        },
      },
    };
    const schema = recursive.components.schemas.Node as Json;
    const result = validateResponse(recursive, schema, { child: { child: { child: {} } } });
    expect(result.status).not.toBe("error");
  });
});

describe("the guard that would have caught the shipped bug", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(resolve(here, "../../../package.json"), "utf8"));
  const deps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };

  // Ajv compiles schemas with `new Function`. Under the webview's CSP that
  // throws, and validation fails for every response — while every test in this
  // file still passes, because Node has no CSP. Depending on it again would
  // reintroduce a bug the test suite cannot otherwise see.
  it("depends on no validator that compiles schemas to JavaScript", () => {
    for (const banned of ["ajv", "ajv-formats", "ajv-draft-04", "ajv-errors"]) {
      expect(deps, `${banned} needs eval; the webview's CSP forbids it`).not.toHaveProperty(banned);
    }
  });

  it("keeps a validator that interprets rather than compiles", () => {
    expect(deps).toHaveProperty("@cfworker/json-schema");
  });

  // The other half: the policy itself must keep forbidding eval, or the
  // dependency rule above is protecting nothing.
  it("keeps the policy that forbids eval in the first place", () => {
    const conf = JSON.parse(readFileSync(resolve(here, "../../../src-tauri/tauri.conf.json"), "utf8"));
    const csp: string = conf.app?.security?.csp ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-eval");
  });
});

describe("with eval genuinely unavailable, as in the webview", () => {
  // The strongest form of the guard above: the dependency list is a proxy, this
  // is the property itself. `new Function` is made to throw exactly as the CSP
  // makes it throw in the app, and validation must still work.
  it("still validates", () => {
    const RealFunction = globalThis.Function;
    const Blocked = function (...args: unknown[]) {
      if (args.length && typeof args[args.length - 1] === "string") {
        throw new EvalError("Refused to evaluate a string as JavaScript");
      }
      return RealFunction as never;
    } as unknown as FunctionConstructor;
    (Blocked as { prototype: unknown }).prototype = RealFunction.prototype;
    globalThis.Function = Blocked;
    try {
      const bad = validateResponse(doc, orderSchema, {
        id: 42,
        customer: { email: "a@b.c" },
      });
      expect(bad.status).toBe("mismatch");
      expect(bad.findings.some((f) => f.kind === "missing_required")).toBe(true);
      expect(bad.findings.some((f) => f.kind === "type_mismatch")).toBe(true);

      const good = validateResponse(doc, orderSchema, {
        id: "or_1",
        amount: 500,
        customer: { email: "a@b.c" },
      });
      expect(good.status).toBe("ok");
    } finally {
      globalThis.Function = RealFunction;
    }
  });
});

describe("an error is reported briefly", () => {
  // The CSP failure interpolated the browser's entire policy into the response
  // pane. Whatever fails next, the note stays readable.
  it("never returns a note long enough to swamp the pane", () => {
    const hostile: Json = { get type() { throw new Error("x\n".repeat(500) + "y".repeat(5000)); } };
    const result = validateResponse(doc, hostile, { a: 1 });
    if (result.status === "error") {
      expect(result.note!.length).toBeLessThan(200);
      expect(result.note).not.toContain("\n");
    }
  });
});
