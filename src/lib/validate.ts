import Ajv, { type ErrorObject } from "ajv";
import addFormats from "ajv-formats";
import { deref, type Json } from "./spec";

/**
 * Validate a live response against the schema the spec declares for its status
 * code — drift detection at the single-request level.
 *
 * Two passes, because they answer different questions:
 *  - Ajv catches what the schema forbids (missing required, wrong type).
 *  - A manual walk catches what the schema never mentioned — undeclared fields.
 *    Specs almost never set `additionalProperties: false`, so Ajv stays silent on
 *    exactly the drift a developer most wants to see.
 */

export type FindingKind = "extra_field" | "missing_required" | "type_mismatch" | "other";

export interface Finding {
  kind: FindingKind;
  path: string;
  message: string;
}

export interface ValidationResult {
  status: "ok" | "mismatch" | "no_schema" | "error";
  findings: Finding[];
  note?: string;
}

/** OpenAPI 3.0 dialect → something Ajv (2020-12/draft-07) will compile. */
function sanitize(node: unknown, seen = new WeakSet<object>()): any {
  if (Array.isArray(node)) return node.map((n) => sanitize(n, seen));
  if (!node || typeof node !== "object") return node;
  if (seen.has(node as object)) return {};
  seen.add(node as object);

  const src = node as Json;
  const out: Json = {};
  for (const [key, value] of Object.entries(src)) {
    // Annotation-only keywords Ajv either rejects or wastes time on.
    if (["example", "examples", "discriminator", "xml", "externalDocs", "deprecated"].includes(key)) {
      continue;
    }
    // 3.0 uses draft-4 booleans here; 2020-12 expects a number.
    if ((key === "exclusiveMinimum" || key === "exclusiveMaximum") && typeof value === "boolean") {
      continue;
    }
    out[key] = sanitize(value, seen);
  }

  // 3.0's `nullable: true` is 3.1's `type: [T, "null"]`.
  if (src.nullable === true && out.type) {
    out.type = Array.isArray(out.type) ? [...out.type, "null"] : [out.type, "null"];
  }
  delete out.nullable;
  return out;
}

/** Walk the response against the schema and report fields the spec never declared. */
function findExtraFields(
  doc: Json,
  schema: Json | undefined,
  data: unknown,
  path: string,
  out: Finding[],
  depth = 0,
): void {
  if (!schema || data === null || data === undefined || depth > 12) return;
  const s = deref(doc, schema);
  if (s["x-circular"] || s["x-unresolved"]) return;

  if (Array.isArray(data)) {
    // One representative element is enough to surface a shape mismatch.
    if (s.items && data.length) findExtraFields(doc, s.items, data[0], `${path}[0]`, out, depth + 1);
    return;
  }
  if (typeof data !== "object") return;

  // Compositions contribute properties from every branch — collect them all
  // before deciding a field is undeclared, or `allOf` produces false positives.
  const declared = new Map<string, Json>();
  const collect = (node: Json | undefined, d = 0) => {
    if (!node || d > 8) return;
    const n = deref(doc, node);
    for (const [k, v] of Object.entries<Json>(n.properties ?? {})) declared.set(k, v);
    for (const branch of [...(n.allOf ?? []), ...(n.oneOf ?? []), ...(n.anyOf ?? [])]) {
      collect(branch, d + 1);
    }
  };
  collect(s);

  const open = s.additionalProperties !== undefined && s.additionalProperties !== false;
  if (declared.size === 0 && !s.properties) return; // free-form object — nothing to compare against

  for (const [key, value] of Object.entries(data as Json)) {
    const child = declared.get(key);
    if (!child) {
      if (!open) {
        out.push({
          kind: "extra_field",
          path: `${path}.${key}`,
          message: `Response contains \`${key}\`, not declared in the spec.`,
        });
      }
      continue;
    }
    findExtraFields(doc, child, value, `${path}.${key}`, out, depth + 1);
  }
}

function describe(error: ErrorObject): Finding {
  const path = `$${error.instancePath.replace(/\//g, ".")}` || "$";
  if (error.keyword === "required") {
    const missing = (error.params as { missingProperty?: string }).missingProperty;
    return {
      kind: "missing_required",
      path: `${path}.${missing}`,
      message: `Required field \`${missing}\` is missing from the response.`,
    };
  }
  if (error.keyword === "type") {
    return {
      kind: "type_mismatch",
      path,
      message: `Expected ${(error.params as { type?: string }).type}, got a different type.`,
    };
  }
  return { kind: "other", path, message: `${error.keyword}: ${error.message ?? "failed"}` };
}

export function validateResponse(
  doc: Json,
  schema: Json | undefined,
  body: unknown,
): ValidationResult {
  if (!schema) {
    return {
      status: "no_schema",
      findings: [],
      note: "The spec doesn't declare a schema for this response.",
    };
  }
  if (body === undefined) {
    return { status: "no_schema", findings: [], note: "Response body isn't JSON." };
  }

  try {
    // `logger: false` matters on real specs — Stripe declares custom formats
    // (`unix-time`, `currency`) and Ajv warns once per occurrence, thousands of times.
    const ajv = new Ajv({
      strict: false,
      allErrors: true,
      allowUnionTypes: true,
      validateFormats: true,
      logger: false,
    });
    addFormats(ajv);

    // Carry `components` into the compiled schema so internal
    // `#/components/schemas/…` pointers still resolve after we detach the subtree.
    const wrapped = {
      ...sanitize(schema),
      components: sanitize({ schemas: doc.components?.schemas ?? {} }),
    };

    const validate = ajv.compile(wrapped);
    const valid = validate(body);

    const findings: Finding[] = valid ? [] : (validate.errors ?? []).map(describe);
    findExtraFields(doc, schema, body, "$", findings);

    // Ajv reports one error per failing branch of a union; collapse duplicates.
    const seen = new Set<string>();
    const unique = findings.filter((f) => {
      const key = `${f.kind}:${f.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return { status: unique.length ? "mismatch" : "ok", findings: unique.slice(0, 40) };
  } catch (error) {
    return {
      status: "error",
      findings: [],
      note: `Couldn't validate: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
