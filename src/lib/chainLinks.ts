import {
  findRefs,
  lookup,
  pathLabel,
  referenceFor,
  valueText,
  type PathSegment,
  type ResolvedLink,
  type StepOutput,
} from "./chain";
import type { Collection, CollectionStep } from "./collection";
import type { BodyInput } from "./request";
import { bodyModeFor, deref, typeLabel, type Json, type OperationSpec } from "./spec";

/**
 * Links between steps: which field of a later step is filled from which field
 * of an earlier step's response.
 *
 * A link is never stored as anything but the `{{steps.<key>.<path>}}` reference
 * already in the step's inputs, so the collection file stays what it was and a
 * reference typed by hand is a link like any other. This module reads links
 * out of the inputs, writes them back as references, and says which ones can't
 * work and why. No React, no IO.
 */

// ── where a link goes ─────────────────────────────────────────────────────────

/**
 * The field a link fills.
 *
 * `body` is a field inside a JSON body, by its path. `text` is a reference
 * somewhere Studio can't name a field for: a body that isn't JSON, a URL, an
 * auth value. Those are still shown and can be changed or removed, but a new
 * link always goes into a named field.
 */
export type LinkTarget =
  | { in: "path" | "query" | "header"; name: string }
  | { in: "body"; path: PathSegment[] }
  | { in: "form"; name: string }
  | { in: "text"; where: "body" | "url" | "auth" | "target" };

export interface LinkSource {
  /** The key of the step whose response the value comes from. */
  step: string;
  /** Into that response: `["body", "id"]`, `["headers", "location"]`, `["status"]`. */
  path: PathSegment[];
}

export interface ChainLink {
  /** Position of the step the link fills. */
  targetIndex: number;
  targetStep: string;
  target: LinkTarget;
  source: LinkSource;
  /** The reference as written in the step. */
  reference: string;
  /**
   * The reference is the field's whole value. A reference inside longer text
   * (`Bearer {{steps.login.body.token}}`) is `false`.
   */
  whole: boolean;
  /** In a JSON body: the reference is a bare value (a number, an object), not inside quotes. */
  bare?: boolean;
}

/** A stable id for a target within its step, for keys and lookups. */
export function targetId(target: LinkTarget): string {
  switch (target.in) {
    case "body":
      return `body:${bodyPathLabel(target.path)}`;
    case "text":
      return `text:${target.where}`;
    default:
      return `${target.in}:${target.name}`;
  }
}

/** `["items", 0, "sku"]` → `items[0].sku`. */
export function bodyPathLabel(path: PathSegment[]): string {
  return path
    .map((segment, index) => (typeof segment === "number" ? `[${segment}]` : index === 0 ? segment : `.${segment}`))
    .join("");
}

/** `items[0].sku` or `body.items[0].sku` → `["items", 0, "sku"]`; null when it isn't a path. */
export function parseBodyPath(text: string): PathSegment[] | null {
  const trimmed = text.trim().replace(/^body(?=[.[]|$)\.?/, "");
  if (!trimmed) return null;
  const out: PathSegment[] = [];
  const pattern = /(?:^|\.)([A-Za-z_$][\w$-]*)|\[(\d+)\]/y;
  let at = 0;
  while (at < trimmed.length) {
    pattern.lastIndex = at;
    const match = pattern.exec(trimmed);
    if (!match) return null;
    out.push(match[2] !== undefined ? Number(match[2]) : match[1]);
    at = pattern.lastIndex;
  }
  return out.length ? out : null;
}

/** How a target reads in the interface: "path orderId", "body.items[0].sku". */
export function describeLinkTarget(target: LinkTarget): string {
  switch (target.in) {
    case "path":
      return `path ${target.name}`;
    case "query":
      return `query ${target.name}`;
    case "header":
      return `header ${target.name}`;
    case "form":
      return `form ${target.name}`;
    case "body":
      return `body.${bodyPathLabel(target.path)}`.replace("body.[", "body[");
    case "text":
      return target.where === "body"
        ? "body text"
        : target.where === "url"
          ? "URL"
          : target.where === "auth"
            ? "auth value"
            : "custom URL";
  }
}

/** How a source field reads: `body.id`, `headers.location`, `status`. */
export function describeSourcePath(path: PathSegment[]): string {
  return pathLabel(path) || "(whole response)";
}

export function sameTarget(a: LinkTarget, b: LinkTarget): boolean {
  return targetId(a) === targetId(b);
}

// ── JSON bodies with references in them ───────────────────────────────────────

/** What a body with references in it holds, once read as JSON. */
export type JsonBodyScan =
  | {
      ok: true;
      value: unknown;
      /** References that stand where a JSON value goes, without quotes, by placeholder number. */
      bare: string[];
      /** Two spaces, a tab, or "" for a body written on one line. */
      indent: string;
    }
  | { ok: false; reason: string };

const PLACEHOLDER = /^\u0000ref:(\d+)\u0000$/;
const placeholder = (n: number) => `\u0000ref:${n}\u0000`;

/**
 * Read a JSON body that may hold `{{references}}`.
 *
 * A reference inside quotes is part of a string and JSON reads it as one. A bare
 * reference (`"amount": {{steps.a.body.total}}`), which is how a number or an
 * object is passed, isn't JSON, so it is swapped for a placeholder string while
 * the text is read and put back when it is written.
 */
export function scanJsonBody(text: string): JsonBodyScan {
  if (!text.trim()) return { ok: true, value: undefined, bare: [], indent: "  " };
  const bare: string[] = [];
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "{" && text[i + 1] === "{") {
      const end = text.indexOf("}}", i + 2);
      const inner = end >= 0 ? text.slice(i + 2, end) : "";
      if (end >= 0 && !/[{}]/.test(inner)) {
        out += JSON.stringify(placeholder(bare.length));
        bare.push(text.slice(i, end + 2));
        i = end + 1;
        continue;
      }
    }
    out += ch;
  }
  try {
    const value = JSON.parse(out);
    return { ok: true, value, bare, indent: detectIndent(text) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function detectIndent(text: string): string {
  if (!text.trim().includes("\n")) return "";
  const line = text.split("\n").find((l) => /^[ \t]+\S/.test(l));
  if (!line) return "  ";
  const lead = line.match(/^[ \t]+/)![0];
  return lead.startsWith("\t") ? "\t" : " ".repeat(Math.min(8, lead.length));
}

/** Write a scanned body back as text, putting bare references back without quotes. */
function writeJsonBody(value: unknown, bare: readonly string[], indent: string): string {
  const text = indent ? JSON.stringify(value, null, indent) : JSON.stringify(value);
  return text.replace(/"\\u0000ref:(\d+)\\u0000"/g, (whole, n: string) => bare[Number(n)] ?? whole);
}

interface BodyRef {
  path: PathSegment[];
  raw: string;
  whole: boolean;
  bare: boolean;
}

/** Every step reference in a scanned JSON body, with the field it sits in. */
function bodyRefs(value: unknown, bare: readonly string[]): BodyRef[] {
  const out: BodyRef[] = [];
  const visit = (node: unknown, path: PathSegment[]) => {
    if (typeof node === "string") {
      const hole = node.match(PLACEHOLDER);
      if (hole) {
        const raw = bare[Number(hole[1])] ?? "";
        const found = findRefs(raw);
        if (found.length === 1 && found[0].raw === raw.trim()) out.push({ path, raw: found[0].raw, whole: true, bare: true });
        return;
      }
      const found = findRefs(node);
      const whole = found.length === 1 && node === found[0].raw;
      for (const ref of found) out.push({ path, raw: ref.raw, whole, bare: false });
      return;
    }
    if (Array.isArray(node)) node.forEach((item, index) => visit(item, [...path, index]));
    else if (node && typeof node === "object") {
      for (const [key, item] of Object.entries(node as Record<string, unknown>)) visit(item, [...path, key]);
    }
  };
  visit(value, []);
  return out;
}

/** Every field path in a scanned JSON body that holds a plain value, for picking a target. */
export function bodyLeafPaths(value: unknown): PathSegment[][] {
  const out: PathSegment[][] = [];
  const visit = (node: unknown, path: PathSegment[], depth: number) => {
    if (out.length > 300 || depth > 8) return;
    if (Array.isArray(node)) {
      if (!node.length && path.length) out.push(path);
      node.slice(0, 20).forEach((item, index) => visit(item, [...path, index], depth + 1));
    } else if (node && typeof node === "object") {
      const entries = Object.entries(node as Record<string, unknown>);
      if (!entries.length && path.length) out.push(path);
      for (const [key, item] of entries) visit(item, [...path, key], depth + 1);
    } else if (path.length) out.push(path);
  };
  visit(value, [], 0);
  return out;
}

function getAt(value: unknown, path: PathSegment[]): { found: boolean; value?: unknown } {
  let here = value;
  for (const segment of path) {
    if (Array.isArray(here) && typeof segment === "number" && segment < here.length) here = here[segment];
    else if (here && typeof here === "object" && !Array.isArray(here) && Object.prototype.hasOwnProperty.call(here, segment)) {
      here = (here as Record<string, unknown>)[String(segment)];
    } else return { found: false };
  }
  return { found: true, value: here };
}

/** A copy of `root` with `value` at `path`, making objects and lists on the way as needed. */
function setAt(root: unknown, path: PathSegment[], value: unknown): unknown {
  if (!path.length) return value;
  const [head, ...rest] = path;
  if (typeof head === "number") {
    const list = Array.isArray(root) ? [...root] : [];
    while (list.length < head) list.push(null);
    list[head] = setAt(list[head], rest, value);
    return list;
  }
  const object = root && typeof root === "object" && !Array.isArray(root) ? { ...(root as Record<string, unknown>) } : {};
  object[head] = setAt(object[head], rest, value);
  return object;
}

/**
 * Put a value at a path in a JSON body. `value` is a JSON value, or
 * `{ reference, bare }` for a step reference (quoted unless `bare`).
 *
 * Returns the new text, or why it couldn't: a body that isn't JSON is never
 * rewritten, since that would throw away what someone typed.
 */
export function setJsonBodyField(
  text: string,
  path: PathSegment[],
  value: unknown | { reference: string; bare: boolean },
): { text: string } | { error: string } {
  const scan = scanJsonBody(text);
  if (!scan.ok) return { error: `The body isn't valid JSON (${scan.reason}), so a field in it can't be set.` };
  if (!path.length) return { error: "Choose a field in the body." };
  const bare = [...scan.bare];
  let leaf: unknown = value;
  if (isRefValue(value)) {
    if (value.bare) {
      leaf = placeholder(bare.length);
      bare.push(value.reference);
    } else leaf = value.reference;
  }
  const next = setAt(scan.value ?? (typeof path[0] === "number" ? [] : {}), path, leaf);
  return { text: writeJsonBody(next, bare, scan.indent) };
}

function isRefValue(value: unknown): value is { reference: string; bare: boolean } {
  return Boolean(
    value && typeof value === "object" && !Array.isArray(value) && typeof (value as { reference?: unknown }).reference === "string" &&
      typeof (value as { bare?: unknown }).bare === "boolean" && Object.keys(value as object).length === 2,
  );
}

// ── reading links out of steps ────────────────────────────────────────────────

/** A body's JSON state, for saying why body fields can't be linked. */
export function bodyProblem(step: CollectionStep): string | null {
  if (typeof step.body !== "string" || !step.body.trim()) return null;
  const scan = scanJsonBody(step.body);
  return scan.ok ? null : `The body isn't valid JSON (${scan.reason}).`;
}

/** The links in one step, wherever its references are. */
export function stepLinks(step: CollectionStep, index: number): ChainLink[] {
  const out: ChainLink[] = [];
  const add = (target: LinkTarget, raw: string, whole: boolean, bare?: boolean) => {
    for (const ref of findRefs(raw)) {
      out.push({
        targetIndex: index,
        targetStep: step.key,
        target,
        source: { step: ref.step, path: ref.path },
        reference: ref.raw,
        whole: whole && raw.trim() === ref.raw,
        ...(bare ? { bare } : {}),
      });
    }
  };
  const bag = (where: "path" | "query" | "header", values: Record<string, string>) => {
    for (const [name, value] of Object.entries(values)) add({ in: where, name }, value, true);
  };
  bag("path", step.pathParams);
  bag("query", step.queryParams);
  bag("header", step.headers);
  if (typeof step.body === "string" && step.body.includes("steps.")) {
    const scan = scanJsonBody(step.body);
    if (scan.ok) {
      for (const ref of bodyRefs(scan.value, scan.bare)) {
        const found = findRefs(ref.raw)[0];
        if (!found) continue;
        out.push({
          targetIndex: index,
          targetStep: step.key,
          target: { in: "body", path: ref.path },
          source: { step: found.step, path: found.path },
          reference: ref.raw,
          whole: ref.whole,
          ...(ref.bare ? { bare: true } : {}),
        });
      }
    } else add({ in: "text", where: "body" }, step.body, false);
  } else if (step.body && typeof step.body !== "string") {
    if (step.body.kind === "form") for (const field of step.body.fields) add({ in: "form", name: field.key }, field.value, true);
    else for (const part of step.body.parts) if (part.value !== undefined) add({ in: "form", name: part.name }, part.value, true);
  }
  if (step.request) add({ in: "text", where: "url" }, step.request.url, false);
  if (step.auth) add({ in: "text", where: "auth" }, step.auth.value, false);
  if (step.target?.kind === "custom") add({ in: "text", where: "target" }, step.target.url, false);
  return out;
}

/** Every link in a collection, in step order. */
export function collectionLinks(collection: Collection): ChainLink[] {
  return collection.steps.flatMap((step, index) => stepLinks(step, index));
}

/** The links whose values come from the step at `index`, from later (or misplaced) steps. */
export function dependentsOf(collection: Collection, index: number): ChainLink[] {
  const key = collection.steps[index]?.key;
  if (!key) return [];
  return collectionLinks(collection).filter((link) => link.source.step === key && link.targetIndex !== index);
}

// ── writing links ─────────────────────────────────────────────────────────────

function withStep(collection: Collection, index: number, change: (step: CollectionStep) => CollectionStep): Collection {
  const step = collection.steps[index];
  if (!step) return collection;
  const next = change(step);
  return next === step ? collection : { ...collection, steps: collection.steps.map((s, i) => (i === index ? next : s)) };
}

function formWith(body: BodyInput | undefined, name: string, value: string): BodyInput {
  if (body && typeof body !== "string" && body.kind === "multipart") {
    const has = body.parts.some((p) => p.name === name);
    return {
      kind: "multipart",
      parts: has
        ? body.parts.map((p) => (p.name === name ? { name: p.name, value, ...(p.contentType ? { contentType: p.contentType } : {}) } : p))
        : [...body.parts, { name, value }],
    };
  }
  const fields = body && typeof body !== "string" && body.kind === "form" ? body.fields : [];
  const has = fields.some((f) => f.key === name);
  return { kind: "form", fields: has ? fields.map((f) => (f.key === name ? { key: f.key, value } : f)) : [...fields, { key: name, value }] };
}

export class LinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkError";
  }
}

/**
 * Fill a field of the step at `index` from an earlier step's response. The
 * field's value becomes the reference; anything it held before is replaced.
 *
 * `bare` is for a JSON body field that isn't a string (a number, a flag, an
 * object): the reference is written without quotes, so the value keeps its type.
 */
export function setLink(
  collection: Collection,
  index: number,
  target: LinkTarget,
  source: LinkSource,
  options: { bare?: boolean } = {},
): Collection {
  const reference = referenceFor(source.step, source.path);
  return withStep(collection, index, (step) => {
    switch (target.in) {
      case "path":
        return { ...step, pathParams: { ...step.pathParams, [target.name]: reference } };
      case "query":
        return { ...step, queryParams: { ...step.queryParams, [target.name]: reference } };
      case "header": {
        // Keep the header's spelling if it's already there in another case.
        const existing = Object.keys(step.headers).find((name) => name.toLowerCase() === target.name.toLowerCase());
        return { ...step, headers: { ...step.headers, [existing ?? target.name]: reference } };
      }
      case "form":
        return { ...step, body: formWith(step.body, target.name, reference) };
      case "body": {
        const text = typeof step.body === "string" ? step.body : "";
        const written = setJsonBodyField(text, target.path, { reference, bare: Boolean(options.bare) });
        if ("error" in written) throw new LinkError(written.error);
        return { ...step, body: written.text };
      }
      case "text":
        throw new LinkError("A new link goes into a named field.");
    }
  });
}

/** Replace one reference in a piece of text, the first time it appears. */
function replaceOnce(text: string, raw: string, next: string): string {
  const at = text.indexOf(raw);
  return at < 0 ? text : text.slice(0, at) + next + text.slice(at + raw.length);
}

/** Change or drop the reference a link is, where it is written. */
function rewriteReference(collection: Collection, link: ChainLink, next: string): Collection {
  return withStep(collection, link.targetIndex, (step) => {
    const swap = (text: string) => replaceOnce(text, link.reference, next);
    const t = link.target;
    switch (t.in) {
      case "path":
        return { ...step, pathParams: { ...step.pathParams, [t.name]: swap(step.pathParams[t.name] ?? "") } };
      case "query":
        return { ...step, queryParams: { ...step.queryParams, [t.name]: swap(step.queryParams[t.name] ?? "") } };
      case "header":
        return { ...step, headers: { ...step.headers, [t.name]: swap(step.headers[t.name] ?? "") } };
      case "form": {
        const body = step.body;
        if (!body || typeof body === "string") return step;
        if (body.kind === "form") return { ...step, body: { kind: "form", fields: body.fields.map((f) => (f.key === t.name ? { ...f, value: swap(f.value) } : f)) } };
        return { ...step, body: { kind: "multipart", parts: body.parts.map((p) => (p.name === t.name && p.value !== undefined ? { ...p, value: swap(p.value) } : p)) } };
      }
      case "body": {
        if (typeof step.body !== "string") return step;
        const scan = scanJsonBody(step.body);
        if (!scan.ok) return { ...step, body: swap(step.body) };
        const here = getAt(scan.value, t.path);
        if (!here.found) return step;
        const hole = typeof here.value === "string" ? here.value.match(PLACEHOLDER) : null;
        if (hole) {
          const bare = scan.bare.map((raw, n) => (n === Number(hole[1]) ? next : raw));
          if (next) return { ...step, body: writeJsonBody(scan.value, bare, scan.indent) };
          // Nothing left where a value goes: that would be invalid JSON.
          const written = setJsonBodyField(step.body, t.path, null);
          return "error" in written ? step : { ...step, body: written.text };
        }
        const current = typeof here.value === "string" ? here.value : "";
        const written = setJsonBodyField(step.body, t.path, replaceOnce(current, link.reference, next));
        return "error" in written ? step : { ...step, body: written.text };
      }
      case "text": {
        if (t.where === "body" && typeof step.body === "string") return { ...step, body: swap(step.body) };
        if (t.where === "url" && step.request) return { ...step, request: { ...step.request, url: swap(step.request.url) } };
        if (t.where === "auth" && step.auth) return { ...step, auth: { ...step.auth, value: swap(step.auth.value) } };
        if (t.where === "target" && step.target?.kind === "custom") return { ...step, target: { kind: "custom", url: swap(step.target.url) } };
        return step;
      }
    }
  });
}

/** Take the value for an existing link from somewhere else, keeping where it goes. */
export function changeLinkSource(collection: Collection, link: ChainLink, source: LinkSource): Collection {
  return rewriteReference(collection, link, referenceFor(source.step, source.path));
}

/**
 * Remove a link. A field that was only the reference is emptied: a parameter
 * becomes blank, a header goes, and a JSON body field gets `replacement` (the
 * spec's example for it, when there is one, else `null`). A reference inside
 * longer text is taken out of the text.
 */
export function removeLink(collection: Collection, link: ChainLink, replacement: unknown = null): Collection {
  if (!link.whole || link.target.in === "form" || link.target.in === "text") return rewriteReference(collection, link, "");
  return withStep(collection, link.targetIndex, (step) => {
    const t = link.target;
    switch (t.in) {
      case "path":
        return { ...step, pathParams: { ...step.pathParams, [t.name]: "" } };
      case "query":
        return { ...step, queryParams: { ...step.queryParams, [t.name]: "" } };
      case "header": {
        const { [t.name]: _gone, ...headers } = step.headers;
        return { ...step, headers };
      }
      case "body": {
        if (typeof step.body !== "string") return step;
        const written = setJsonBodyField(step.body, t.path, replacement);
        return "error" in written ? step : { ...step, body: written.text };
      }
      default:
        return step;
    }
  });
}

/**
 * Change a link: where its value comes from, and maybe the field it fills.
 * Moving it to another field removes it from the old one first.
 */
export function editLink(
  collection: Collection,
  link: ChainLink,
  next: { targetIndex: number; target: LinkTarget; source: LinkSource; bare?: boolean },
  replacement: unknown = null,
): Collection {
  if (next.targetIndex === link.targetIndex && sameTarget(next.target, link.target)) {
    return changeLinkSource(collection, link, next.source);
  }
  const cleared = removeLink(collection, link, replacement);
  return setLink(cleared, next.targetIndex, next.target, next.source, { bare: next.bare });
}

// ── is it going to work? ──────────────────────────────────────────────────────

/** What is known about a step's response, to check a link against. */
export interface SourceFacts {
  /** The last run's response, when the step ran. */
  output?: StepOutput;
  /**
   * The fields its declared success response has (as `fieldsFromSchema` lists
   * them, array items as `0`). Undefined when the spec declares no body.
   */
  schemaFields?: PathSegment[][];
}

/**
 * - `ok`: the value is there (in the last response, or declared by the spec).
 * - `unchecked`: can't be told yet, e.g. a header before any run, or a field
 *   the spec doesn't declare; it may still work.
 * - `broken`: it can't work as things stand, with the reason and what would fix it.
 */
export type LinkCheck =
  | { state: "ok"; basis: "response" | "schema" }
  | { state: "unchecked"; reason: string }
  | { state: "broken"; reason: string; fix: LinkFix };

export type LinkFix =
  /** Move the source step up to just before the step that uses it. */
  | { kind: "move"; from: number; to: number }
  /** Pick another value, because this one isn't there. */
  | { kind: "choose" };

function normalise(path: PathSegment[]): string {
  return path.map((segment) => (typeof segment === "number" || /^\d+$/.test(String(segment)) ? "[0]" : `.${segment}`)).join("");
}

/** What to call a step in a sentence: its name, else its key. */
export function stepLabel(step: CollectionStep | undefined, fallback = "that step"): string {
  return step ? step.name || step.key : fallback;
}

export function checkLink(
  collection: Collection,
  link: Pick<ChainLink, "targetIndex" | "source">,
  facts: (key: string) => SourceFacts | undefined,
): LinkCheck {
  const sourceIndex = collection.steps.findIndex((s) => s.key === link.source.step);
  const target = collection.steps[link.targetIndex];
  if (sourceIndex < 0) {
    return {
      state: "broken",
      reason: `There's no step "${link.source.step}" in this collection any more. It was removed, or its key changed outside Studio.`,
      fix: { kind: "choose" },
    };
  }
  const source = collection.steps[sourceIndex];
  const name = stepLabel(source);
  if (sourceIndex === link.targetIndex) {
    return { state: "broken", reason: "A step can't use a value from its own response.", fix: { kind: "choose" } };
  }
  if (sourceIndex > link.targetIndex) {
    return {
      state: "broken",
      reason: `${name} (step ${sourceIndex + 1}) runs after ${stepLabel(target, "this step")} (step ${link.targetIndex + 1}), so its response isn't there yet.`,
      fix: { kind: "move", from: sourceIndex, to: link.targetIndex },
    };
  }
  const [root, ...rest] = link.source.path;
  if (root !== "status" && root !== "headers" && root !== "body") {
    return { state: "broken", reason: "It doesn't say which part of the response to use.", fix: { kind: "choose" } };
  }
  const known = facts(link.source.step);
  const field = describeSourcePath(link.source.path);
  if (known?.output) {
    const found = lookup(known.output, link.source.step, link.source.path);
    if (found.found) return { state: "ok", basis: "response" };
    return {
      state: "broken",
      reason: `${field} wasn't in ${name}'s last response.`,
      fix: { kind: "choose" },
    };
  }
  if (root === "status") return { state: "ok", basis: "schema" };
  if (root === "headers") {
    return { state: "unchecked", reason: `Response headers are known once ${name} has run.` };
  }
  if (!known?.schemaFields) {
    return { state: "unchecked", reason: `${name} hasn't run, and its spec declares no response body to check against.` };
  }
  if (!rest.length) return { state: "ok", basis: "schema" };
  const wanted = normalise(link.source.path);
  const declared = known.schemaFields.some((path) => {
    const have = normalise(path);
    return have === wanted || have.startsWith(`${wanted}.`) || have.startsWith(`${wanted}[`);
  });
  return declared
    ? { state: "ok", basis: "schema" }
    : { state: "unchecked", reason: `${field} isn't in the response the spec declares for ${name}. Run the collection to check it.` };
}

/**
 * The links a move would break: ones that work now and whose source would then
 * run at or after the step that uses it.
 */
export function linksBrokenByMove(collection: Collection, from: number, to: number): ChainLink[] {
  if (from === to) return [];
  const order = collection.steps.map((s) => s.key);
  const [moved] = order.splice(from, 1);
  order.splice(Math.max(0, Math.min(order.length, to)), 0, moved);
  const before = (key: string) => collection.steps.findIndex((s) => s.key === key);
  const after = (key: string) => order.indexOf(key);
  return collectionLinks(collection).filter((link) => {
    const source = before(link.source.step);
    if (source < 0 || source >= link.targetIndex) return false; // already broken
    return after(link.source.step) >= after(link.targetStep);
  });
}

/** The value a link passed on the last run, redacted by the caller before it's shown. */
export function linkValue(link: Pick<ChainLink, "source">, outputs: ReadonlyMap<string, StepOutput>): string | undefined {
  const output = outputs.get(link.source.step);
  if (!output) return undefined;
  const found = lookup(output, link.source.step, link.source.path);
  return found.found ? valueText(found.value) : undefined;
}

/**
 * Where a run says a value went (`ResolvedLink.target` in `chain.ts`): `path
 * orderId`, `header Authorization`, `body`, `url`, `auth`, `target`.
 */
export function runTargetLabel(target: LinkTarget): string {
  switch (target.in) {
    case "path":
    case "query":
    case "header":
      return `${target.in} ${target.name}`;
    case "body":
    case "form":
      return "body";
    case "text":
      return target.where;
  }
}

/**
 * The value a link passed, from what a run recorded (`references_resolved`
 * events): matched by where it went and the reference it came from. Undefined
 * when the run didn't reach it or couldn't resolve it.
 */
export function passedValue(
  link: Pick<ChainLink, "target" | "reference">,
  recorded: ReadonlyArray<ResolvedLink>,
): string | undefined {
  const source = link.reference.replace(/^\{\{\s*|\s*\}\}$/g, "");
  const where = runTargetLabel(link.target);
  return recorded.find((r) => r.source === source && r.target === where && r.value !== undefined)?.value;
}

// ── fields a link can fill ────────────────────────────────────────────────────

export interface LinkableField {
  target: LinkTarget;
  group: "Path parameters" | "Query parameters" | "Headers" | "Body fields" | "Form fields";
  label: string;
  /** The type the spec gives it, when it gives one. */
  type?: string;
  required?: boolean;
  /** What the step holds for it now. */
  current?: string;
  /** For a body field: write the reference without quotes, so a number stays a number. */
  bare?: boolean;
}

/** The JSON type at a path in a schema, following `$ref`, `items` and `allOf`. */
export function schemaTypeAt(doc: Json, schema: Json | undefined, path: PathSegment[]): string | undefined {
  let node: Json | undefined = schema;
  for (const segment of path) {
    if (!node) return undefined;
    const resolved = deref(doc, node);
    if (typeof segment === "number") {
      node = resolved.items;
      continue;
    }
    const direct = resolved.properties?.[segment];
    if (direct) {
      node = direct;
      continue;
    }
    node = (resolved.allOf ?? []).map((part: Json) => deref(doc, part).properties?.[segment]).find(Boolean);
  }
  if (!node) return undefined;
  const resolved = deref(doc, node);
  if (typeof resolved.type === "string") return resolved.type;
  if (resolved.properties) return "object";
  if (resolved.items) return "array";
  return undefined;
}

/** Leaf paths of a request body schema, arrays as their first item. */
function schemaLeaves(doc: Json, schema: Json | undefined): Array<{ path: PathSegment[]; required: boolean }> {
  const out: Array<{ path: PathSegment[]; required: boolean }> = [];
  const visit = (node: Json | undefined, path: PathSegment[], required: boolean, depth: number, seen: Set<Json>) => {
    if (!node || out.length > 200 || depth > 6) return;
    const resolved = deref(doc, node);
    if (seen.has(resolved)) return;
    const next = new Set(seen).add(resolved);
    if (resolved.type === "array" || resolved.items) {
      if (path.length) out.push({ path, required });
      visit(resolved.items, [...path, 0], false, depth + 1, next);
      return;
    }
    const props = Object.entries<Json>(resolved.properties ?? {});
    const parts: Json[] = resolved.allOf ?? [];
    if (!props.length && !parts.length) {
      if (path.length) out.push({ path, required });
      return;
    }
    // An object field can be filled whole, e.g. an amount passed on as it came back.
    if (path.length && props.length) out.push({ path, required });
    const need: string[] = resolved.required ?? [];
    for (const [name, prop] of props) visit(prop, [...path, name], required && need.includes(name), depth + 1, next);
    for (const part of parts) visit(part, path, required, depth + 1, next);
  };
  visit(schema, [], true, 0, new Set());
  return out;
}

/**
 * The fields of a step a value can go into: the operation's parameters, the
 * step's own headers, and the body's fields (from the spec's schema and from
 * the body as written). `doc` and `op` are null for a step that isn't linked
 * to an operation; then only what the step already holds is offered.
 */
export function linkableFields(step: CollectionStep, op: OperationSpec | null, doc: Json | null): LinkableField[] {
  const out: LinkableField[] = [];
  const seen = new Set<string>();
  const push = (field: LinkableField) => {
    const id = targetId(field.target).toLowerCase();
    if (seen.has(id)) return;
    seen.add(id);
    out.push(field);
  };
  const groups = { path: "Path parameters", query: "Query parameters", header: "Headers" } as const;
  const bags = { path: step.pathParams, query: step.queryParams, header: step.headers } as const;
  for (const param of op?.parameters ?? []) {
    if (param.in === "cookie") continue;
    const bag = bags[param.in] as Record<string, string>;
    const current = param.in === "header"
      ? Object.entries(bag).find(([name]) => name.toLowerCase() === param.name.toLowerCase())?.[1]
      : bag[param.name];
    push({
      target: { in: param.in, name: param.name },
      group: groups[param.in],
      label: param.name,
      ...(doc ? { type: typeLabel(doc, param.schema) } : {}),
      required: param.required,
      ...(current !== undefined ? { current } : {}),
    });
  }
  for (const where of ["path", "query", "header"] as const) {
    for (const [name, value] of Object.entries(bags[where])) {
      push({ target: { in: where, name }, group: groups[where], label: name, current: value });
    }
  }
  const mode = op?.requestBody ? bodyModeFor(op.requestBody.contentType) : typeof step.body === "string" || !step.body ? "text" : step.body.kind;
  if (mode === "text" && (op?.requestBody || typeof step.body === "string")) {
    const text = typeof step.body === "string" ? step.body : "";
    const scan = scanJsonBody(text);
    const schema = op?.requestBody?.schema;
    const leaves = doc && schema ? schemaLeaves(doc, schema) : [];
    const written = scan.ok ? bodyLeafPaths(scan.value) : [];
    const all = [
      ...leaves,
      ...written.map((path) => ({ path, required: false })),
    ];
    for (const { path, required } of all) {
      const type = doc && schema ? schemaTypeAt(doc, schema, path) : undefined;
      const here = scan.ok ? getAt(scan.value, path) : { found: false };
      const current = here.found ? describeBodyValue(here.value, scan.ok ? scan.bare : []) : undefined;
      const writtenType = here.found ? jsonType(here.value) : undefined;
      const kind = type ?? writtenType;
      push({
        target: { in: "body", path },
        group: "Body fields",
        label: bodyPathLabel(path),
        ...(type ? { type } : {}),
        required,
        ...(current !== undefined ? { current } : {}),
        bare: kind !== undefined && kind !== "string",
      });
    }
  } else if (mode === "form" || mode === "multipart") {
    const names = new Set<string>();
    if (step.body && typeof step.body !== "string") {
      if (step.body.kind === "form") step.body.fields.forEach((f) => names.add(f.key));
      else step.body.parts.forEach((p) => p.value !== undefined && names.add(p.name));
    }
    const schema = op?.requestBody?.schema;
    if (doc && schema) for (const name of Object.keys(deref(doc, schema).properties ?? {})) names.add(name);
    for (const name of names) {
      if (!name) continue;
      const body = step.body && typeof step.body !== "string" ? step.body : null;
      const current = body?.kind === "form" ? body.fields.find((f) => f.key === name)?.value : body?.parts.find((p) => p.name === name)?.value;
      push({ target: { in: "form", name }, group: "Form fields", label: name, ...(current !== undefined ? { current } : {}) });
    }
  }
  return out;
}

function jsonType(value: unknown): string | undefined {
  if (typeof value === "string") return PLACEHOLDER.test(value) ? "bare" : "string";
  if (value === null) return undefined;
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function describeBodyValue(value: unknown, bare: readonly string[]): string {
  if (typeof value === "string") {
    const hole = value.match(PLACEHOLDER);
    return hole ? (bare[Number(hole[1])] ?? "") : value;
  }
  return JSON.stringify(value);
}

/** The spec's example for one body field, to put back when its link is removed. */
export function bodyExampleAt(example: unknown, path: PathSegment[]): unknown {
  const here = getAt(example, path);
  return here.found ? here.value : null;
}

// ── everything at once, for the chain view ────────────────────────────────────

export interface LinkView extends ChainLink {
  /** Unique within the collection, for keys and highlighting. */
  id: string;
  /** Where the source step is now; -1 when there's no such step. */
  sourceIndex: number;
  check: LinkCheck;
  /** The value it passed on the last run, when its source ran. Not redacted: redact before showing. */
  value?: string;
}

/** Every link with its check and last value. */
export function analyseChain(
  collection: Collection,
  facts: (key: string) => SourceFacts | undefined,
  outputs: ReadonlyMap<string, StepOutput>,
  /** What the last run recorded for each step (by key), when there's a run log. */
  recorded?: (stepKey: string) => ReadonlyArray<ResolvedLink> | undefined,
): LinkView[] {
  const seen = new Map<string, number>();
  return collectionLinks(collection).map((link) => {
    const base = `${link.targetIndex}|${targetId(link.target)}|${link.reference}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    // What the run itself recorded, when it did; else the value in the source's last response.
    const logged = recorded?.(link.targetStep);
    const value = logged ? passedValue(link, logged) : linkValue(link, outputs);
    return {
      ...link,
      id: `${base}|${n}`,
      sourceIndex: collection.steps.findIndex((s) => s.key === link.source.step),
      check: checkLink(collection, link, facts),
      ...(value !== undefined ? { value } : {}),
    };
  });
}
