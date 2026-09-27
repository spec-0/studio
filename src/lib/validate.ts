import { Validator, type OutputUnit } from "@cfworker/json-schema";
import { deref, type Json, type ResponseSpec } from "./spec";

/**
 * Validate a live response against the schema the spec declares for its status
 * code — drift detection at the single-request level.
 *
 * Two passes, because they answer different questions:
 *  - The schema validator catches what the schema forbids (missing required,
 *    wrong type).
 *  - A manual walk catches what the schema never mentioned — undeclared fields.
 *    Specs almost never set `additionalProperties: false`, so a validator stays
 *    silent on exactly the drift a developer most wants to see.
 *
 * **The validator must not compile schemas to JavaScript.** Ajv was the obvious
 * choice and shipped here first, but it builds validators with `new Function`,
 * which the webview's content security policy forbids — so every response came
 * back `Couldn't validate` with a wall of CSP text where the schema check should
 * have been. Relaxing the policy to `unsafe-eval` would have fixed it in one
 * line and been the wrong trade: the schemas fed to this function come from
 * whatever document was opened, so that combination hands a code generator
 * attacker-controllable input. This validator interprets the schema instead of
 * compiling it, so there is nothing to eval. `test/validate.test.ts` asserts the
 * dependency stays that way.
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

/** OpenAPI 3.0 dialect → the 2020-12 dialect the validator speaks. */
function sanitize(node: unknown, seen = new WeakSet<object>()): any {
  if (Array.isArray(node)) return node.map((n) => sanitize(n, seen));
  if (!node || typeof node !== "object") return node;
  if (seen.has(node as object)) return {};
  seen.add(node as object);

  const src = node as Json;
  const out: Json = {};
  for (const [key, value] of Object.entries(src)) {
    // Annotation-only keywords a validator either rejects or wastes time on.
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

/**
 * Keywords whose failure only means "something below me failed".
 *
 * The validator reports the whole chain: a wrong field type arrives as a `type`
 * error *and* a `properties` error above it *and* a `$ref` error above that.
 * Showing all three lists one problem three times and buries the one line that
 * says what is actually wrong, so the wrappers are dropped and the specific
 * error is kept.
 */
const WRAPPER_KEYWORDS = new Set([
  "properties",
  "patternProperties",
  "additionalProperties",
  "unevaluatedProperties",
  "items",
  "prefixItems",
  "additionalItems",
  "unevaluatedItems",
  "contains",
  "$ref",
  "$recursiveRef",
  "allOf",
  "dependentSchemas",
  "if",
  "then",
  "else",
]);

/** `#/customer/email` → `$.customer.email`, undoing JSON-pointer escaping. */
function pointerToPath(location: string): string {
  const body = location.replace(/^#/, "");
  if (!body) return "$";
  const segments = body
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  return segments.length ? `$.${segments.join(".")}` : "$";
}

function describe(error: OutputUnit): Finding {
  const path = pointerToPath(error.instanceLocation);

  if (error.keyword === "required") {
    // The property name is inside the message rather than a structured field,
    // so it is read back out — and if the wording ever changes, the generic
    // message below is still true rather than wrong.
    const missing = /"([^"]+)"/.exec(error.error)?.[1];
    return missing
      ? {
          kind: "missing_required",
          path: `${path === "$" ? "$" : path}.${missing}`,
          message: `Required field \`${missing}\` is missing from the response.`,
        }
      : { kind: "missing_required", path, message: error.error };
  }

  if (error.keyword === "type") {
    const expected = /Expected "([^"]+)"/.exec(error.error)?.[1];
    return {
      kind: "type_mismatch",
      path,
      message: expected
        ? `Expected ${expected}, got a different type.`
        : error.error,
    };
  }

  return { kind: "other", path, message: `${error.keyword}: ${error.error}` };
}

/** First line of an error, capped — never a whole stack or policy dump. */
function brief(error: unknown, limit = 160): string {
  const raw = (error instanceof Error ? error.message : String(error)).trim();
  const firstLine = raw.split("\n")[0];
  return firstLine.length > limit ? `${firstLine.slice(0, limit - 1)}…` : firstLine;
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
    // Carry `components` into the schema so internal `#/components/schemas/…`
    // pointers still resolve after the subtree is detached from the document.
    const wrapped = {
      ...sanitize(schema),
      components: sanitize({ schemas: doc.components?.schemas ?? {} }),
    };

    // `shortCircuit: false` — every failure is wanted, not just the first, or a
    // response with three problems reports one and looks nearly correct.
    const result = new Validator(wrapped, "2020-12", false).validate(body);

    const specific = result.errors.filter((e) => !WRAPPER_KEYWORDS.has(e.keyword));
    // Composition keywords are wrappers when a branch failed underneath them and
    // the whole story when none did — so they are only dropped if something more
    // specific survived. An invalid response must never report zero findings.
    const reported = specific.length ? specific : result.errors;

    const findings: Finding[] = result.valid ? [] : reported.map(describe);
    findExtraFields(doc, schema, body, "$", findings);

    // A union reports one error per failing branch; collapse duplicates.
    const seen = new Set<string>();
    const unique = findings.filter((f) => {
      const key = `${f.kind}:${f.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return { status: unique.length ? "mismatch" : "ok", findings: unique.slice(0, 40) };
  } catch (error) {
    // Kept short on purpose. This used to interpolate the raw error, and when
    // the CSP blocked Ajv's `new Function` the browser's several-hundred-character
    // policy dump landed in the response pane where the schema check belongs.
    // Whatever goes wrong next, the pane stays readable.
    return { status: "error", findings: [], note: `Couldn't validate: ${brief(error)}` };
  }
}

/**
 * The response the spec declares for a status code: the exact code, then its
 * range (`2XX`), then `default`.
 *
 * One function for every place that checks a response — a single send, a bulk
 * run, and re-checking a recorded response. They used to each carry their own
 * copy, and the copy that re-checked history had lost the range step, so a
 * response the live check matched against `2XX` came back from history as "no
 * schema". Range keys are matched case-insensitively; OpenAPI says uppercase,
 * specs in the wild don't always agree.
 */
export function declaredResponse<T extends Pick<ResponseSpec, "status">>(
  responses: readonly T[],
  status: number,
): T | undefined {
  const exact = String(status);
  const range = `${Math.floor(status / 100)}XX`;
  return (
    responses.find((r) => r.status === exact) ??
    responses.find((r) => r.status.toUpperCase() === range) ??
    responses.find((r) => r.status === "default")
  );
}
