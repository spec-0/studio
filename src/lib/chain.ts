import { deref, type Json } from "./spec";

/**
 * Using a value from an earlier step: `{{steps.createOrder.body.id}}`.
 *
 * A reference names a step by its key, then `status`, `headers` or `body`, then
 * a path into it: `.name` for a field, `[0]` (or `.0`) for an array item. No
 * expressions and no scripting — a reference points at one value, and picking
 * it by clicking is the main way to write one.
 *
 * Resolved before environment variables, so `{{token}}` next to a step
 * reference still comes from the active environment.
 */

/** What a step's response offers to the steps after it. */
export interface StepOutput {
  status: number;
  headers: Record<string, string>;
  /** The body parsed as JSON, when it was JSON. */
  json?: unknown;
  /** The body as text. */
  text: string;
}

const REF = /\{\{\s*steps\.([A-Za-z_][A-Za-z0-9_-]*)((?:\.[^\s{}.[\]]+|\[\d+\])*)\s*\}\}/g;

export type PathSegment = string | number;

/** `.body.items[0].id` → `["body", "items", 0, "id"]`. */
export function parsePath(path: string): PathSegment[] {
  const out: PathSegment[] = [];
  for (const match of path.matchAll(/\.([^\s{}.[\]]+)|\[(\d+)\]/g)) {
    if (match[2] !== undefined) out.push(Number(match[2]));
    else out.push(match[1]);
  }
  return out;
}

/** A reference for a value, with array items as `[n]`. */
export function referenceFor(stepKey: string, path: PathSegment[]): string {
  const tail = path
    .map((segment) =>
      typeof segment === "number" ? `[${segment}]` : `.${segment}`,
    )
    .join("");
  return `{{steps.${stepKey}${tail}}}`;
}

/** One `{{steps.…}}` reference found in a piece of text. */
export interface FoundRef {
  /** The reference exactly as written, braces included. */
  raw: string;
  /** Where it starts in the text. */
  index: number;
  step: string;
  path: PathSegment[];
}

/** Every step reference in `text`, in order. */
export function findRefs(text: string): FoundRef[] {
  if (!text || !text.includes("steps.")) return [];
  return [...text.matchAll(REF)].map((match) => ({
    raw: match[0],
    index: match.index ?? 0,
    step: match[1],
    path: parsePath(match[2]),
  }));
}

/** `["body", "items", 0, "sku"]` → `body.items[0].sku`, as the interface shows a field. */
export function pathLabel(path: PathSegment[]): string {
  return describePath(path);
}

/** A value as it is put into a request: strings as they are, anything else as JSON. */
export function valueText(value: unknown): string {
  return asText(value);
}

/** The step keys a piece of text refers to. */
export function referencedSteps(text: string): string[] {
  return [...new Set([...text.matchAll(REF)].map((match) => match[1]))];
}

function describePath(path: PathSegment[]): string {
  return path
    .map((segment, index) =>
      typeof segment === "number" ? `[${segment}]` : index === 0 ? segment : `.${segment}`,
    )
    .join("");
}

function asText(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

type Lookup = { found: true; value: unknown } | { found: false; problem: string };

function walk(value: unknown, path: PathSegment[], label: string): Lookup {
  let here = value;
  for (let index = 0; index < path.length; index += 1) {
    const segment = path[index];
    const soFar = `${label}${describePath(path.slice(0, index + 1)).replace(/^(?!\[)/, ".")}`;
    if (Array.isArray(here)) {
      const at = typeof segment === "number" ? segment : /^\d+$/.test(segment) ? Number(segment) : NaN;
      if (Number.isNaN(at)) return { found: false, problem: `${soFar}: that's a list, so use an index like [0]` };
      if (at >= here.length) return { found: false, problem: `${soFar}: the list has ${here.length} item${here.length === 1 ? "" : "s"}` };
      here = here[at];
    } else if (here && typeof here === "object") {
      const key = String(segment);
      if (!Object.prototype.hasOwnProperty.call(here, key)) {
        return { found: false, problem: `${soFar}: not in the response` };
      }
      here = (here as Record<string, unknown>)[key];
    } else {
      return { found: false, problem: `${soFar}: the response has no field here` };
    }
  }
  return { found: true, value: here };
}

/** Look up one reference's value in a step's output. */
export function lookup(output: StepOutput, stepKey: string, path: PathSegment[]): Lookup {
  const [root, ...rest] = path;
  const label = `steps.${stepKey}.${String(root)}`;
  if (root === "status") {
    return rest.length ? { found: false, problem: `${label} is a number and has no fields` } : { found: true, value: output.status };
  }
  if (root === "headers") {
    if (rest.length !== 1) return { found: false, problem: `${label} needs a header name, e.g. .headers.location` };
    const wanted = String(rest[0]).toLowerCase();
    const hit = Object.entries(output.headers).find(([name]) => name.toLowerCase() === wanted);
    return hit ? { found: true, value: hit[1] } : { found: false, problem: `${label}.${rest[0]}: no such header in the response` };
  }
  if (root === "body") {
    if (!rest.length) return { found: true, value: output.json !== undefined ? output.json : output.text };
    if (output.json === undefined) return { found: false, problem: `${label}: the response body isn't JSON` };
    return walk(output.json, rest, label);
  }
  return {
    found: false,
    problem: `steps.${stepKey}${describePath(path).replace(/^(?!\[)/, path.length ? "." : "")}: continue with .status, .headers or .body`,
  };
}

export interface ResolveContext {
  /** Every step key in the collection, to tell a typo from a step that hasn't run. */
  keys: readonly string[];
  /** Outputs of the steps that have run so far in this run. */
  outputs: ReadonlyMap<string, StepOutput>;
}

/**
 * One `{{steps.…}}` reference as a run resolved it: where it was used, which
 * step's value it named, and the value, or why there wasn't one.
 */
export interface ResolvedLink {
  /** Where the value went, e.g. `path orderId` or `header Authorization`. Empty when the caller didn't say. */
  target: string;
  /** The reference without braces, e.g. `steps.createOrder.body.id`. */
  source: string;
  /** The value used, as text. Absent when it couldn't be resolved. */
  value?: string;
  /** Why it couldn't be resolved. */
  error?: string;
}

/**
 * Fill in every `{{steps.…}}` reference in `text`.
 *
 * Anything that can't be filled is reported, not guessed: a step that fails for
 * a reference it couldn't resolve says which reference and why, and nothing is
 * sent with a hole in it.
 *
 * `links` lists every reference met, resolved or not, for the run log; `target`
 * says where the text is used and is copied onto each one.
 */
export function resolveStepRefs(
  text: string,
  context: ResolveContext,
  target = "",
): { text: string; errors: string[]; links: ResolvedLink[] } {
  if (!text.includes("steps.")) return { text, errors: [], links: [] };
  const errors: string[] = [];
  const links: ResolvedLink[] = [];
  const fail = (whole: string, source: string, error: string) => {
    errors.push(error);
    links.push({ target, source, error });
    return whole;
  };
  const filled = text.replace(REF, (whole, key: string, rawPath: string) => {
    const path = parsePath(rawPath);
    const source = `steps.${key}${rawPath}`;
    if (!context.keys.includes(key)) {
      return fail(whole, source, `${whole}: there's no step called "${key}" in this collection`);
    }
    const output = context.outputs.get(key);
    if (!output) {
      return fail(whole, source, `${whole}: step "${key}" hasn't run yet in this run, so it has no response to use`);
    }
    if (!path.length) {
      return fail(whole, source, `${whole}: say which part to use, e.g. {{steps.${key}.body.id}}`);
    }
    const result = lookup(output, key, path);
    if (!result.found) return fail(whole, source, result.problem);
    const value = asText(result.value);
    links.push({ target, source, value });
    return value;
  });
  return { text: filled, errors: [...new Set(errors)], links };
}

// ── what can be picked ────────────────────────────────────────────────────────

export interface PickableField {
  path: PathSegment[];
  reference: string;
  /** A short preview of the value, or the schema's type when there's no value yet. */
  preview: string;
}

const MAX_FIELDS = 200;

/** Every leaf value in a step's last response, for the picker. */
export function fieldsFromOutput(stepKey: string, output: StepOutput): PickableField[] {
  const out: PickableField[] = [{ path: ["status"], reference: referenceFor(stepKey, ["status"]), preview: String(output.status) }];
  const visit = (value: unknown, path: PathSegment[], depth: number) => {
    if (out.length >= MAX_FIELDS) return;
    if (value && typeof value === "object" && depth < 8) {
      // An object or a list can be passed on whole, as well as field by field.
      if (path.length > 1) {
        const preview = Array.isArray(value) ? `[${value.length} item${value.length === 1 ? "" : "s"}]` : "{…}";
        out.push({ path, reference: referenceFor(stepKey, path), preview });
      }
      const entries = Array.isArray(value)
        ? value.slice(0, 20).map((item, index) => [index, item] as const)
        : Object.entries(value as Record<string, unknown>);
      for (const [segment, item] of entries) visit(item, [...path, segment], depth + 1);
      return;
    }
    const text = asText(value);
    out.push({
      path,
      reference: referenceFor(stepKey, path),
      preview: text.length > 60 ? `${text.slice(0, 59)}…` : text,
    });
  };
  if (output.json !== undefined) visit(output.json, ["body"], 0);
  for (const name of Object.keys(output.headers).slice(0, 20)) {
    out.push({ path: ["headers", name], reference: referenceFor(stepKey, ["headers", name]), preview: output.headers[name] });
  }
  return out;
}

/**
 * The fields a step's declared success response has, for picking before the
 * step has ever run. Arrays offer their first item.
 */
export function fieldsFromSchema(stepKey: string, doc: Json, schema: Json | undefined): PickableField[] {
  const out: PickableField[] = [];
  const visit = (node: Json | undefined, path: PathSegment[], depth: number, seen: Set<Json>) => {
    if (out.length >= MAX_FIELDS || !node) return;
    const resolved = deref(doc, node);
    if (seen.has(resolved) || depth > 5) return;
    const next = new Set(seen).add(resolved);
    if (resolved.type === "array" || resolved.items) {
      if (path.length > 1) out.push({ path, reference: referenceFor(stepKey, path), preview: "array" });
      visit(resolved.items, [...path, 0], depth + 1, next);
      return;
    }
    const props = Object.entries<Json>(resolved.properties ?? {});
    const composed: Json[] = [...(resolved.allOf ?? [])];
    if (path.length > 1 && props.length) out.push({ path, reference: referenceFor(stepKey, path), preview: "object" });
    if (!props.length && !composed.length) {
      if (path.length > 1) {
        out.push({ path, reference: referenceFor(stepKey, path), preview: String(resolved.type ?? "value") });
      }
      return;
    }
    for (const [name, prop] of props) visit(prop, [...path, name], depth + 1, next);
    for (const part of composed) visit(part, path, depth + 1, next);
  };
  visit(schema, ["body"], 0, new Set());
  return [{ path: ["status"], reference: referenceFor(stepKey, ["status"]), preview: "integer" }, ...out];
}
