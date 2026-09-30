import { deref, type Json } from "./spec";

/**
 * Build a realistic instance of a schema.
 *
 * The point of a spec-native client: a developer should never see `"string"` in
 * a request body. The same rules fill the request editor and answer requests to
 * a local mock (`localMock.ts`), so both show the same values. In order:
 *
 *  1. an example on the media type (`mediaExample`), when there is one;
 *  2. the schema's own `example` or `examples`;
 *  3. for objects and arrays, each property or item built by these same rules,
 *     so property examples are used;
 *  4. `default`, then `const`, then the first `enum` value;
 *  5. a value that fits the `format` (date-time, email, uuid…);
 *  6. a value guessed from the property name, then a placeholder for the type.
 *
 * A request leaves out `readOnly` properties (the server sets them); a response
 * leaves out `writeOnly` ones (a server never sends a password back).
 */

const NOW = "2026-08-01T09:30:00Z";

function fromFormat(format: string): unknown | undefined {
  switch (format) {
    case "date-time":
      return NOW;
    case "date":
      return NOW.slice(0, 10);
    case "time":
      return "09:30:00";
    case "email":
      return "ada@example.com";
    case "uuid":
      return "3f1a7c62-9b40-4e8d-8a21-5c7f0d2e4b91";
    case "uri":
    case "url":
      return "https://example.com/resource";
    case "hostname":
      return "api.example.com";
    case "ipv4":
      return "192.0.2.1";
    case "ipv6":
      return "2001:db8::1";
    case "byte":
      return "c3BlYzA=";
    case "password":
      return "correct-horse-battery-staple";
    default:
      return undefined;
  }
}

/** Last-resort inference from the property's name — `email`, `createdAt`, `count`… */
function fromName(name: string, type: string | undefined): unknown | undefined {
  const n = name.toLowerCase();
  if (type && type !== "string" && type !== "integer" && type !== "number") return undefined;
  if (n === "id" || n.endsWith("_id") || n.endsWith("Id")) return "id_7f3a92c1";
  if (n.includes("email")) return "ada@example.com";
  if (n.includes("url") || n.includes("uri") || n.includes("link")) return "https://example.com";
  if (n.includes("phone")) return "+1-555-0142";
  if (n.includes("name")) return n.includes("first") ? "Ada" : n.includes("last") ? "Lovelace" : "Ada Lovelace";
  if (n.includes("currency")) return "USD";
  if (n.includes("country")) return "US";
  if (n.includes("description") || n.includes("summary")) return "A short description.";
  if (n.endsWith("at") || n.includes("date") || n.includes("time")) return NOW;
  if (n.includes("count") || n.includes("quantity") || n.includes("total")) return 2;
  if (n.includes("amount") || n.includes("price") || n.includes("cost")) return 1999;
  return undefined;
}

/** Which way the value travels: it decides whether `readOnly` or `writeOnly` properties are left out. */
export type Direction = "request" | "response";

interface Ctx {
  doc: Json;
  seen: Set<string>;
  depth: number;
  direction: Direction;
}

/** The first value of a schema's `examples`: an array in JSON Schema, a map of Example objects in some specs. */
function firstExample(doc: Json, examples: unknown): { found: boolean; value?: unknown } {
  if (Array.isArray(examples)) return examples.length ? { found: true, value: examples[0] } : { found: false };
  if (examples && typeof examples === "object") {
    for (const raw of Object.values(examples as Json)) {
      const example = raw && typeof raw === "object" ? deref(doc, raw) : undefined;
      if (example && example.value !== undefined) return { found: true, value: example.value };
    }
  }
  return { found: false };
}

function build(schema: Json | undefined, name: string, ctx: Ctx): unknown {
  if (!schema || ctx.depth > 6) return null;

  // A `$ref` we're already inside — stop, or a recursive model never terminates.
  if (typeof schema.$ref === "string" && ctx.seen.has(schema.$ref)) return null;
  const seen = typeof schema.$ref === "string" ? new Set(ctx.seen).add(schema.$ref) : ctx.seen;
  const s = deref(ctx.doc, schema);
  if (s["x-circular"] || s["x-unresolved"]) return null;

  const next: Ctx = { ...ctx, seen, depth: ctx.depth + 1 };

  // The spec told us what this looks like — always prefer it.
  if (s.example !== undefined) return s.example;
  const listed = firstExample(ctx.doc, s.examples);
  if (listed.found) return listed.value;
  if (s.default !== undefined) return s.default;
  if (s.const !== undefined) return s.const;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];

  if (Array.isArray(s.allOf)) {
    return s.allOf.reduce<Record<string, unknown>>((acc, part) => {
      const value = build(part, name, next);
      return value && typeof value === "object" && !Array.isArray(value)
        ? { ...acc, ...(value as Record<string, unknown>) }
        : acc;
    }, {});
  }
  const variants = s.oneOf ?? s.anyOf;
  if (Array.isArray(variants) && variants.length) return build(variants[0], name, next);

  const type = Array.isArray(s.type) ? s.type.find((t: string) => t !== "null") : s.type;

  switch (type) {
    case "object":
    case undefined: {
      if (!s.properties && !s.additionalProperties) return type === "object" ? {} : null;
      const out: Record<string, unknown> = {};
      for (const [key, prop] of Object.entries<Json>(s.properties ?? {})) {
        const resolved = deref(ctx.doc, prop);
        if (ctx.direction === "request" ? resolved?.readOnly : resolved?.writeOnly) continue;
        out[key] = build(prop, key, next);
      }
      return out;
    }
    case "array": {
      const item = build(s.items, name, next);
      return item === null ? [] : [item];
    }
    case "boolean":
      return true;
    case "integer":
    case "number": {
      const named = fromName(name, type);
      if (typeof named === "number") return named;
      if (typeof s.minimum === "number") return s.minimum;
      if (typeof s.maximum === "number" && s.maximum < 1) return s.maximum;
      return type === "integer" ? 1 : 1.5;
    }
    case "null":
      return null;
    case "string":
    default: {
      if (s.format) {
        const byFormat = fromFormat(s.format);
        if (byFormat !== undefined) return byFormat;
      }
      const named = fromName(name, "string");
      if (named !== undefined) return named;
      if (typeof s.minLength === "number" && s.minLength > 6) return "x".repeat(s.minLength);
      if (s.pattern) return `matches:${s.pattern}`;
      return "string";
    }
  }
}

export function exampleFor(
  doc: Json,
  schema: Json | undefined,
  name = "value",
  direction: Direction = "request",
): unknown {
  return build(schema, name, { doc, seen: new Set(), depth: 0, direction });
}

/**
 * The value for one media type (`content["application/json"]`): its own
 * `example`, then the first of its `examples` (following a `$ref` to
 * `components/examples`), then a value built from its schema. `undefined` when
 * the media type has neither an example nor a schema.
 */
export function mediaExample(doc: Json, media: Json | undefined, direction: Direction = "request"): unknown {
  if (!media || typeof media !== "object") return undefined;
  if (media.example !== undefined) return media.example;
  const listed = firstExample(doc, media.examples);
  if (listed.found) return listed.value;
  if (!media.schema) return undefined;
  return exampleFor(doc, media.schema, "body", direction);
}

/** The request editor's starting body. `media` is the media type object, for its examples. */
export function exampleBody(doc: Json, schema: Json | undefined, media?: Json): string {
  const value = media ? mediaExample(doc, media, "request") : schema ? exampleFor(doc, schema, "body") : undefined;
  if (value === null || value === undefined) return "";
  return JSON.stringify(value, null, 2);
}

/** Seed a parameter input with something plausible rather than an empty box. */
export function exampleParam(doc: Json, schema: Json | undefined, name: string): string {
  const value = exampleFor(doc, schema, name);
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}
