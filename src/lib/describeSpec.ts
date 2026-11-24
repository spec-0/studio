import { dump } from "js-yaml";
import type { Collection } from "./collection";
import { interpolate } from "./env";
import { isScratch, type HistoryEntry } from "./history";
import { redact } from "./redact";

/**
 * Describe as a spec: a draft OpenAPI 3.1 document written from requests that
 * were already sent, so scratch requests and steps that aren't in a spec can
 * get a schema, checks and a mock without anyone writing YAML by hand.
 *
 * Everything here works on what History recorded. Nothing is sent to build it
 * (design rule 1). What it writes is a starting point, not the truth: a word
 * segment like `/users/me` stays a literal, a field seen once is optional, and
 * the user is expected to read and edit the result like any other spec.
 *
 * Secrets never reach the document. Auth headers, cookies, API-key headers and
 * token-like query values are left out; a bearer or basic `Authorization`
 * header becomes a security scheme with no value, and so does an API key in a
 * header or the query. Examples drop fields with secret-looking names and any
 * value that was sent as a credential.
 */

/** One request and what came back, as History keeps it. */
export interface Sample {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  bodyKind?: "text" | "form" | "multipart";
  /** Missing when the request was never sent (a collection step not run yet). */
  status?: number;
  statusText?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  /** The caller's name for this sample, to find which operation it became (a step key). */
  tag?: string;
}

export interface DescribedOperation {
  operationId: string;
  method: string;
  path: string;
  /** Status codes seen, lowest first. */
  statuses: number[];
  /** How many requests it was written from. */
  samples: number;
}

export interface DescribedSpec {
  origin: string;
  doc: Record<string, unknown>;
  yaml: string;
  operations: DescribedOperation[];
  /** The operation each tagged sample became. The newest sample of a tag wins. */
  byTag: Record<string, { operationId: string; method: string; path: string }>;
  /** What was left out because it looked like a secret, in words, for the dialog. */
  leftOut: string[];
}

// Samples from what Studio recorded

export function sampleFromEntry(entry: HistoryEntry, tag?: string): Sample {
  return {
    method: entry.method,
    url: entry.url,
    headers: entry.headers,
    body: entry.body,
    bodyKind: entry.bodyKind,
    status: entry.status,
    statusText: entry.statusText,
    responseHeaders: entry.responseHeaders,
    responseBody: entry.responseBody,
    ...(tag ? { tag } : {}),
  };
}

/** Every scratch call in History. A status of 0 means nothing came back, so it's left out. */
export function scratchSamples(history: readonly HistoryEntry[]): Sample[] {
  return history.filter((entry) => isScratch(entry) && entry.status > 0).map((entry) => sampleFromEntry(entry));
}

/**
 * A collection's steps that aren't in a spec, each tagged with its key: every
 * recorded run of the step, or, for a step never run, the request it would
 * send. Its URL is filled from the environment and then redacted, so a secret
 * in a variable can't come through it.
 */
export function collectionSamples(
  collection: Collection,
  history: readonly HistoryEntry[],
  vars: Record<string, string> = {},
): Sample[] {
  const samples: Sample[] = [];
  for (const step of collection.steps) {
    if (step.api || !step.request) continue;
    const runs = history.filter(
      (entry) => isScratch(entry) && entry.status > 0 && entry.collection?.id === collection.id && entry.collection.step === step.key,
    );
    if (runs.length) {
      for (const entry of runs) samples.push(sampleFromEntry(entry, step.key));
      continue;
    }
    samples.push({
      method: step.request.method,
      url: redact(interpolate(step.request.url, vars)),
      headers: step.headers,
      ...(typeof step.body === "string" ? { body: step.body } : {}),
      tag: step.key,
    });
  }
  return samples;
}

/** How many unlinked steps a collection has: the ones Describe as a spec can write operations for. */
export function unlinkedSteps(collection: Collection): number {
  return collection.steps.filter((step) => !step.api && step.request).length;
}

// Hosts

/** The origins the samples went to, the busiest first. A spec describes one. */
export function hostsOf(samples: readonly Sample[]): Array<{ origin: string; host: string; count: number }> {
  const counts = new Map<string, { origin: string; host: string; count: number }>();
  for (const sample of samples) {
    const url = parseUrl(sample.url);
    if (!url) continue;
    const found = counts.get(url.origin);
    if (found) found.count += 1;
    else counts.set(url.origin, { origin: url.origin, host: url.host, count: 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));
}

// Secrets

const SECRET_WORDS = [
  "token",
  "secret",
  "password",
  "passwd",
  "apikey",
  "accesskey",
  "signature",
  "credential",
  "cookie",
  "session",
  "authorization",
  "privatekey",
  "jwt",
];
const SECRET_EXACT = new Set(["auth", "key", "sig", "pwd", "sid", "pass"]);

/** A header, query or field name that usually carries a credential. */
export function isSecretName(name: string): boolean {
  const flat = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SECRET_EXACT.has(flat) || SECRET_WORDS.some((word) => flat.includes(word));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A value that reads like a credential: a `{{reference}}`, a bearer or basic value, a JWT, a key. */
export function looksLikeSecret(value: string): boolean {
  const text = value.trim();
  if (text.includes("{{")) return true;
  if (/^(bearer|basic|token)\s+\S/i.test(text)) return true;
  if (/^eyJ[\w-]+\.[\w-]+\.[\w-]*$/.test(text)) return true;
  if (/^(sk|pk|rk|ghp|gho|ghs|ghu|github_pat|xox[abprs]|AKIA)[-_]?[A-Za-z0-9]/.test(text) && text.length >= 16) return true;
  if (UUID.test(text)) return false;
  return text.length >= 32 && /^[A-Za-z0-9+/=_.-]+$/.test(text) && /\d/.test(text) && /[a-z]/i.test(text);
}

function isAuthHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "authorization" || lower === "proxy-authorization";
}

// Path templating

const NOISE = /^(v\d+(\.\d+)*|api|rest)$/i;

/** A segment that is an id rather than a name: a number, a UUID, a long hex or random string. */
export function isIdSegment(segment: string): boolean {
  const text = safeDecode(segment);
  if (text.includes("{{")) return true;
  if (/^-?\d+$/.test(text)) return true;
  if (UUID.test(text)) return true;
  if (/^[0-9a-f]{8,}$/i.test(text) && /\d/.test(text)) return true;
  if (/^[a-z]{2,8}_[A-Za-z0-9]{8,}$/.test(text)) return true; // cus_9s6XKzkNRiz8i3
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return true;
  return text.length >= 16 && /^[A-Za-z0-9_-]+$/.test(text) && /\d/.test(text) && /[a-z]/i.test(text);
}

const PARAM = "\u0000";

/**
 * Which segments of each path are parameters. Id-like segments always are. A
 * word segment is one only when other requests differ from it in that segment
 * alone and agree on the literal segment after it (`/users/alice/repos`,
 * `/users/bob/repos`); `/users` next to `/posts` stays as it is.
 */
export function templatePaths(paths: readonly string[][]): boolean[][] {
  const marks = paths.map((segments) => segments.map(isIdSegment));
  let changed = true;
  while (changed) {
    changed = false;
    const groups = new Map<string, number[]>();
    paths.forEach((segments, p) => {
      segments.forEach((_, i) => {
        if (i === 0 || i === segments.length - 1 || marks[p][i] || marks[p][i + 1]) return;
        const key = `${i}|${segments.map((s, j) => (j === i ? "*" : marks[p][j] ? PARAM : s)).join("/")}`;
        groups.set(key, [...(groups.get(key) ?? []), p]);
      });
    });
    for (const [key, members] of groups) {
      const i = Number(key.split("|")[0]);
      if (new Set(members.map((p) => paths[p][i])).size < 2) continue;
      for (const p of members) {
        if (!marks[p][i]) {
          marks[p][i] = true;
          changed = true;
        }
      }
    }
  }
  return marks;
}

/** `users` → `user`, `categories` → `category`, `statuses` → `status`. Good enough for names. */
export function singular(word: string): string {
  if (/ies$/i.test(word) && word.length > 3) return word.slice(0, -3) + "y";
  if (/(ch|sh|x|z|ss|us)es$/i.test(word)) return word.slice(0, -2);
  if (/(ss|us|is)$/i.test(word)) return word;
  if (/s$/i.test(word) && word.length > 1) return word.slice(0, -1);
  return word;
}

function words(text: string): string[] {
  return safeDecode(text)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

function pascal(text: string): string {
  return words(text)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join("");
}

function camel(text: string): string {
  const p = pascal(text);
  return p ? p[0].toLowerCase() + p.slice(1) : "";
}

function unique(base: string, taken: Set<string>): string {
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${base}${n}`;
  taken.add(name);
  return name;
}

interface Template {
  /** Segments, with a parameter's name in place of each templated one. */
  segments: Array<{ literal: string } | { param: string }>;
  path: string;
}

function templateOf(segments: string[], marks: boolean[]): Template {
  const taken = new Set<string>();
  const out: Template["segments"] = segments.map((segment, i) => {
    if (!marks[i]) return { literal: segment };
    const before = i > 0 && !marks[i - 1] && !NOISE.test(segments[i - 1]) ? camel(singular(segments[i - 1])) : "";
    return { param: unique(before ? `${before}Id` : "id", taken) };
  });
  const path = `/${out.map((s) => ("param" in s ? `{${s.param}}` : s.literal)).join("/")}`;
  return { segments: out, path };
}

// Schemas from JSON values

type JsonType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
const TYPE_ORDER: JsonType[] = ["object", "array", "string", "number", "integer", "boolean", "null"];

interface Shape {
  types: Set<JsonType>;
  formats: Set<string>;
  strings: number;
  objects: number;
  props: Map<string, Shape>;
  presence: Map<string, number>;
  items: Shape | null;
}

const emptyShape = (): Shape => ({
  types: new Set(),
  formats: new Set(),
  strings: 0,
  objects: 0,
  props: new Map(),
  presence: new Map(),
  items: null,
});

function formatOf(text: string): string {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(text)) return "date-time";
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return "date";
  if (UUID.test(text)) return "uuid";
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return "email";
  if (/^https?:\/\/\S+$/.test(text)) return "uri";
  return "";
}

/** Add one value seen to a shape. */
function observe(shape: Shape, value: unknown): Shape {
  if (value === null) shape.types.add("null");
  else if (Array.isArray(value)) {
    shape.types.add("array");
    for (const item of value) shape.items = observe(shape.items ?? emptyShape(), item);
  } else if (typeof value === "object") {
    shape.types.add("object");
    shape.objects += 1;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      shape.props.set(key, observe(shape.props.get(key) ?? emptyShape(), item));
      shape.presence.set(key, (shape.presence.get(key) ?? 0) + 1);
    }
  } else if (typeof value === "string") {
    shape.types.add("string");
    shape.strings += 1;
    shape.formats.add(formatOf(value));
  } else if (typeof value === "number") shape.types.add(Number.isInteger(value) ? "integer" : "number");
  else if (typeof value === "boolean") shape.types.add("boolean");
  return shape;
}

/** Merge two shapes, as if every value of both had been seen by one. */
function mergeShapes(a: Shape, b: Shape): Shape {
  const out = emptyShape();
  for (const t of [...a.types, ...b.types]) out.types.add(t);
  for (const f of [...a.formats, ...b.formats]) out.formats.add(f);
  out.strings = a.strings + b.strings;
  out.objects = a.objects + b.objects;
  for (const source of [a, b]) {
    for (const [key, shape] of source.props) {
      const existing = out.props.get(key);
      out.props.set(key, existing ? mergeShapes(existing, shape) : shape);
      out.presence.set(key, (out.presence.get(key) ?? 0) + (source.presence.get(key) ?? 0));
    }
  }
  out.items = a.items && b.items ? mergeShapes(a.items, b.items) : (a.items ?? b.items);
  return out;
}

/** An object shape on its own (or with null), worth a name in `components/schemas`. */
function isObjectShape(shape: Shape): boolean {
  return shape.types.has("object") && [...shape.types].every((t) => t === "object" || t === "null") && shape.props.size > 0;
}

function similarity(a: Shape, b: Shape): number {
  const keys = new Set([...a.props.keys(), ...b.props.keys()]);
  if (!keys.size) return 1;
  const both = [...keys].filter((k) => a.props.has(k) && b.props.has(k)).length;
  return both / keys.size;
}

/** The JSON Schema (2020-12, as OpenAPI 3.1 uses it) for a shape. */
function render(shape: Shape): Record<string, unknown> {
  const types = TYPE_ORDER.filter((t) => shape.types.has(t) && !(t === "integer" && shape.types.has("number")));
  if (!types.length) return {};
  const schema: Record<string, unknown> = { type: types.length === 1 ? types[0] : types };
  if (shape.types.has("string")) {
    const formats = [...shape.formats];
    if (formats.length === 1 && formats[0]) schema.format = formats[0];
  }
  if (shape.types.has("object") && shape.props.size) {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, prop] of shape.props) {
      properties[key] = render(prop);
      if ((shape.presence.get(key) ?? 0) === shape.objects) required.push(key);
    }
    schema.properties = properties;
    if (required.length) schema.required = required;
  }
  if (shape.types.has("array")) {
    schema.items = shape.items ? render(shape.items) : {};
  }
  return schema;
}

// Examples

const EXAMPLE_ITEMS = 3;

/**
 * A recorded value fit to show as an example: fields with secret-looking
 * names and credential-like values are left out, and long lists are cut to a
 * few items. Undefined when nothing safe is left.
 */
export function safeExample(value: unknown, secrets: ReadonlySet<string> = new Set()): unknown {
  const bad = (text: string) => looksLikeSecret(text) || [...secrets].some((secret) => text.includes(secret));
  if (typeof value === "string") return bad(value) ? undefined : value;
  if (Array.isArray(value)) {
    return value
      .slice(0, EXAMPLE_ITEMS)
      .map((item) => safeExample(item, secrets))
      .filter((item) => item !== undefined);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretName(key)) continue;
      const kept = safeExample(item, secrets);
      if (kept !== undefined) out[key] = kept;
    }
    return out;
  }
  return value;
}

// Building the document

const STATUS_TEXT: Record<number, string> = {
  200: "OK",
  201: "Created",
  202: "Accepted",
  204: "No Content",
  301: "Moved Permanently",
  302: "Found",
  304: "Not Modified",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  422: "Unprocessable Content",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

const METHOD_ORDER = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

interface Parsed {
  sample: Sample;
  url: URL;
  segments: string[];
}

function parseUrl(text: string): URL | null {
  try {
    const url = new URL(text);
    return /^https?:$/.test(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function header(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key === undefined ? undefined : headers[key];
}

function mediaType(contentType: string | undefined): string | undefined {
  const type = contentType?.split(";")[0].trim().toLowerCase();
  return type || undefined;
}

function isJsonType(type: string | undefined): boolean {
  return Boolean(type && (type === "application/json" || type.endsWith("+json") || type.endsWith("/json")));
}

/** The body as JSON, when it is JSON. */
function jsonOf(text: string | undefined, type: string | undefined): { ok: true; value: unknown } | { ok: false } {
  if (text === undefined || !text.trim()) return { ok: false };
  if (type && !isJsonType(type)) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function scalarSchema(values: string[]): Record<string, unknown> {
  if (values.length && values.every((v) => /^-?\d+$/.test(v))) return { type: "integer" };
  if (values.length && values.every((v) => v.trim() !== "" && !Number.isNaN(Number(v)))) return { type: "number" };
  if (values.length && values.every((v) => v === "true" || v === "false")) return { type: "boolean" };
  if (values.length && values.every((v) => UUID.test(v))) return { type: "string", format: "uuid" };
  return { type: "string" };
}

function exampleFor(values: string[], schema: Record<string, unknown>): unknown {
  const value = values.find((v) => !looksLikeSecret(v));
  if (value === undefined) return undefined;
  if (schema.type === "integer" || schema.type === "number") return Number(value);
  if (schema.type === "boolean") return value === "true";
  return value;
}

/** The schemes a sample authenticated with, adding each to `schemes` the first time it's seen. */
function authOf(
  sample: Sample,
  url: URL,
  schemes: Map<string, Record<string, unknown>>,
  schemeNames: Map<string, string>,
  secrets: Set<string>,
  leftOut: Set<string>,
): string[] {
  const used: string[] = [];
  const add = (signature: string, base: string, scheme: Record<string, unknown>) => {
    let name = schemeNames.get(signature);
    if (!name) {
      name = unique(base, new Set(schemes.keys()));
      schemeNames.set(signature, name);
      schemes.set(name, scheme);
    }
    if (!used.includes(name)) used.push(name);
  };
  const remember = (value: string) => {
    const text = value.trim();
    if (text.length >= 4 && !text.includes("{{")) secrets.add(text);
  };
  for (const [name, value] of Object.entries(sample.headers ?? {})) {
    const lower = name.toLowerCase();
    if (isAuthHeader(lower)) {
      leftOut.add(`the ${name} header`);
      remember(value);
      const [, scheme = "", credential = ""] = /^(\S+)\s+(.*)$/.exec(value.trim()) ?? [];
      if (credential) remember(credential);
      if (/^bearer$/i.test(scheme)) add("http:bearer", "bearerAuth", { type: "http", scheme: "bearer" });
      else if (/^basic$/i.test(scheme)) {
        add("http:basic", "basicAuth", { type: "http", scheme: "basic" });
        try {
          const decoded = atob(credential);
          remember(decoded);
          remember(decoded.split(":").slice(1).join(":"));
        } catch {
          // Not base64; the credential itself is already remembered.
        }
      } else add(`header:${lower}`, "apiKeyAuth", { type: "apiKey", in: "header", name });
    } else if (lower === "cookie") {
      leftOut.add("the Cookie header");
      for (const pair of value.split(";")) remember(pair.split("=").slice(1).join("="));
    } else if (isSecretName(lower)) {
      leftOut.add(`the ${name} header`);
      remember(value);
      add(`header:${lower}`, camel(name) || "apiKeyAuth", { type: "apiKey", in: "header", name });
    }
  }
  for (const [name, value] of url.searchParams) {
    if (!isSecretName(name)) continue;
    leftOut.add(`the ${name} query parameter`);
    remember(value);
    add(`query:${name}`, camel(name) || "apiKeyQuery", { type: "apiKey", in: "query", name });
  }
  return used;
}

interface Operation {
  method: string;
  template: Template;
  members: Parsed[];
}

/** A readable operationId: `listPosts`, `getUser`, `createPost`, `listUserPosts`. */
function operationIdFor(op: Operation, returnsList: boolean): string {
  const segments = op.template.segments;
  const parts: string[] = [];
  segments.forEach((segment, i) => {
    if (!("literal" in segment) || NOISE.test(segment.literal)) return;
    const next = segments[i + 1];
    const last = !segments.slice(i + 1).some((s) => "literal" in s && !NOISE.test(s.literal));
    const keepPlural = last && !next && op.method === "GET" && returnsList;
    parts.push(pascal(keepPlural ? segment.literal : singular(segment.literal)));
  });
  const endsInParam = segments.length > 0 && "param" in segments[segments.length - 1];
  const verb =
    op.method === "GET"
      ? !endsInParam && returnsList
        ? "list"
        : "get"
      : op.method === "POST"
        ? "create"
        : op.method === "PUT"
          ? "replace"
          : op.method === "PATCH"
            ? "update"
            : op.method.toLowerCase();
  return `${verb}${parts.join("") || "Root"}`;
}

/**
 * Write a draft OpenAPI 3.1 document from the samples sent to `origin`.
 * Samples to other hosts, and ones whose URL can't be read, are ignored.
 */
export function describeSpec(samples: readonly Sample[], origin: string, options: { title?: string } = {}): DescribedSpec {
  const parsed: Parsed[] = [];
  for (const sample of samples) {
    const url = parseUrl(sample.url);
    if (!url || url.origin !== origin) continue;
    parsed.push({ sample, url, segments: url.pathname.split("/").filter(Boolean) });
  }
  const host = parseUrl(origin)?.host ?? origin;

  // Paths and operations
  const marks = templatePaths(parsed.map((p) => p.segments));
  const ops = new Map<string, Operation>();
  parsed.forEach((p, i) => {
    const template = templateOf(p.segments, marks[i]);
    const method = p.sample.method.toUpperCase();
    const key = `${method} ${template.path}`;
    const op = ops.get(key) ?? { method, template, members: [] };
    op.members.push(p);
    ops.set(key, op);
  });
  const ordered = [...ops.values()].sort(
    (a, b) =>
      a.template.path.localeCompare(b.template.path) ||
      (METHOD_ORDER.indexOf(a.method) + 1 || 99) - (METHOD_ORDER.indexOf(b.method) + 1 || 99),
  );

  // Secrets first, so examples can leave out anything that was sent as one.
  const schemes = new Map<string, Record<string, unknown>>();
  const schemeNames = new Map<string, string>();
  const secrets = new Set<string>();
  const leftOut = new Set<string>();
  const authBySample = new Map<Parsed, string[]>();
  for (const p of parsed) authBySample.set(p, authOf(p.sample, p.url, schemes, schemeNames, secrets, leftOut));

  // Components: shapes collected first, merged by name, rendered at the end.
  const components = new Map<string, Shape>();
  const named = (shape: Shape, base: string, fallback: string): Record<string, unknown> => {
    let name = base;
    const existing = components.get(name);
    if (existing && similarity(existing, shape) < 0.5) {
      name = fallback;
      for (let n = 2; components.has(name) && similarity(components.get(name)!, shape) < 0.5; n += 1) name = `${fallback}${n}`;
    }
    const merged = components.has(name) ? mergeShapes(components.get(name)!, shape) : shape;
    components.set(name, merged);
    return { $ref: `#/components/schemas/${name}` };
  };
  /** A body's schema: a named component for an object (or a list of them), inline otherwise. */
  const bodySchema = (shape: Shape, base: string, fallback: string): Record<string, unknown> => {
    if (isObjectShape(shape)) return named(shape, base, fallback);
    if (shape.types.size === 1 && shape.types.has("array") && shape.items && isObjectShape(shape.items)) {
      return { type: "array", items: named(shape.items, base, fallback) };
    }
    return render(shape);
  };

  const paths: Record<string, Record<string, unknown>> = {};
  const operations: DescribedOperation[] = [];
  const byTag: DescribedSpec["byTag"] = {};
  const takenIds = new Set<string>();

  for (const op of ordered) {
    const members = op.members;
    const returnsList = members.some((m) => {
      if (!m.sample.status || m.sample.status >= 300) return false;
      const json = jsonOf(m.sample.responseBody, mediaType(header(m.sample.responseHeaders, "content-type")));
      return json.ok && Array.isArray(json.value);
    });
    const operationId = unique(operationIdFor(op, returnsList), takenIds);
    const literals = op.template.segments.filter((s): s is { literal: string } => "literal" in s && !NOISE.test(s.literal));
    const resource = literals.length ? pascal(singular(literals[literals.length - 1].literal)) : "Root";
    const operation: Record<string, unknown> = { operationId };

    // Parameters
    const parameters: Record<string, unknown>[] = [];
    op.template.segments.forEach((segment, i) => {
      if (!("param" in segment)) return;
      const values = members.map((m) => safeDecode(m.segments[i]));
      const schema = scalarSchema(values.filter((v) => !v.includes("{{")));
      const example = exampleFor(values, schema);
      parameters.push({ name: segment.param, in: "path", required: true, schema, ...(example !== undefined ? { example } : {}) });
    });
    const queryNames: string[] = [];
    for (const m of members) for (const name of m.url.searchParams.keys()) if (!queryNames.includes(name)) queryNames.push(name);
    for (const name of queryNames) {
      if (isSecretName(name)) continue;
      const values = members.flatMap((m) => m.url.searchParams.getAll(name));
      const repeated = members.some((m) => m.url.searchParams.getAll(name).length > 1);
      const scalar = scalarSchema(values.filter((v) => !looksLikeSecret(v)));
      const example = exampleFor(values, scalar);
      const required = members.every((m) => m.url.searchParams.has(name));
      parameters.push({
        name,
        in: "query",
        ...(required ? { required: true } : {}),
        schema: repeated ? { type: "array", items: scalar } : scalar,
        ...(example !== undefined ? { example: repeated ? [example] : example } : {}),
      });
    }
    if (parameters.length) operation.parameters = parameters;

    // Request body
    const withBody = members.filter((m) => m.sample.body !== undefined && m.sample.body.trim() !== "" && !["GET", "HEAD"].includes(op.method));
    if (withBody.length) {
      const bodies = new Map<string, { shape: Shape | null; example?: unknown }>();
      for (const m of withBody) {
        const kind = m.sample.bodyKind ?? "text";
        const declared = mediaType(header(m.sample.headers, "content-type"));
        const type =
          kind === "form"
            ? "application/x-www-form-urlencoded"
            : kind === "multipart"
              ? "multipart/form-data"
              : (declared ?? (jsonOf(m.sample.body, undefined).ok ? "application/json" : "text/plain"));
        const seen = bodies.get(type) ?? { shape: null };
        bodies.set(type, seen);
        const json = kind === "text" ? jsonOf(m.sample.body, type) : ({ ok: false } as const);
        if (!json.ok) continue;
        seen.shape = observe(seen.shape ?? emptyShape(), json.value);
        seen.example ??= safeExample(json.value, secrets);
      }
      const content: Record<string, Record<string, unknown>> = {};
      for (const [type, { shape, example }] of bodies) {
        content[type] = shape
          ? {
              schema: bodySchema(shape, `${resource}Input`, `${pascal(operationId)}Request`),
              ...(example !== undefined ? { example } : {}),
            }
          : {};
      }
      operation.requestBody = { ...(withBody.length === members.length ? { required: true } : {}), content };
    }

    // Responses
    const statuses = [...new Set(members.map((m) => m.sample.status).filter((s): s is number => typeof s === "number" && s > 0))].sort(
      (a, b) => a - b,
    );
    const responses: Record<string, unknown> = {};
    for (const status of statuses) {
      const seen = members.filter((m) => m.sample.status === status);
      const response: Record<string, unknown> = {
        description: seen.find((m) => m.sample.statusText)?.sample.statusText || STATUS_TEXT[status] || "Response",
      };
      const bodies = new Map<string, { shape: Shape | null; example?: unknown }>();
      for (const m of seen) {
        const declared = mediaType(header(m.sample.responseHeaders, "content-type"));
        const body = m.sample.responseBody;
        if (!body || !body.trim()) continue;
        const json = jsonOf(body, declared);
        const type = declared ?? (json.ok ? "application/json" : "text/plain");
        const media = bodies.get(type) ?? { shape: null };
        bodies.set(type, media);
        if (!json.ok) continue;
        media.shape = observe(media.shape ?? emptyShape(), json.value);
        media.example ??= safeExample(json.value, secrets);
      }
      const content: Record<string, Record<string, unknown>> = {};
      for (const [type, { shape, example }] of bodies) {
        content[type] = shape
          ? {
              schema:
                status >= 400
                  ? bodySchema(shape, "Error", `${pascal(operationId)}Error`)
                  : bodySchema(shape, resource, `${pascal(operationId)}Response`),
              ...(example !== undefined ? { example } : {}),
            }
          : {};
      }
      if (Object.keys(content).length) response.content = content;
      responses[String(status)] = response;
    }
    if (!statuses.length) responses.default = { description: "No response was recorded for this request yet." };
    operation.responses = responses;

    // Security: each distinct set of schemes one request used; `{}` when some used none.
    const sets: string[][] = [];
    let anonymous = false;
    for (const m of members) {
      const used = authBySample.get(m) ?? [];
      if (!used.length) anonymous = true;
      else if (!sets.some((s) => s.join() === used.join())) sets.push(used);
    }
    if (sets.length) {
      operation.security = [
        ...sets.map((set) => Object.fromEntries(set.map((name) => [name, []]))),
        ...(anonymous ? [{}] : []),
      ];
    }

    (paths[op.template.path] ??= {})[op.method.toLowerCase()] = operation;
    operations.push({ operationId, method: op.method, path: op.template.path, statuses, samples: members.length });
    for (const m of members) {
      if (m.sample.tag && !byTag[m.sample.tag]) byTag[m.sample.tag] = { operationId, method: op.method, path: op.template.path };
    }
  }

  // Render the components now every shape is merged in. Nested objects stay inline.
  const schemas: Record<string, unknown> = {};
  for (const [name, shape] of [...components.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    schemas[name] = render(shape);
  }
  const componentsDoc: Record<string, unknown> = {};
  if (Object.keys(schemas).length) componentsDoc.schemas = schemas;
  if (schemes.size) componentsDoc.securitySchemes = Object.fromEntries(schemes);

  const doc: Record<string, unknown> = {
    openapi: "3.1.0",
    info: {
      title: options.title?.trim() || host,
      version: "0.1.0",
      description: `Drafted by spec0 Studio from ${parsed.length} request${parsed.length === 1 ? "" : "s"} to ${host}. Read it through before relying on it.`,
    },
    servers: [{ url: origin }],
    paths,
    ...(Object.keys(componentsDoc).length ? { components: componentsDoc } : {}),
  };
  const yaml = dump(doc, { noRefs: true, lineWidth: -1 });
  return { origin, doc, yaml, operations, byTag, leftOut: [...leftOut] };
}

/** A file name for the draft: `jsonplaceholder-typicode-com.openapi.yaml`. */
export function suggestedSpecFileName(host: string): string {
  const slug = host
    .toLowerCase()
    .replace(/:\d+$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "api"}.openapi.yaml`;
}
