import { dump, load } from "js-yaml";
import { fingerprint } from "./history";
import type { SourceKind } from "./library";
import { redact, redactHeaders } from "./redact";
import type { BodyInput, MultipartPart } from "./request";

/**
 * Collections: ordered steps that point at operations in your specs.
 *
 * A collection never holds a copy of an operation. Each step names the API it
 * comes from and the operation in it (by `operationId`, with method and path as
 * a fallback), and keeps only its own inputs: parameter values, headers, a body
 * and where to send it. The spec stays the source of truth for everything else,
 * which is how a step's response can be checked against it and how Studio can
 * tell when a step no longer matches.
 *
 * This file is the model and the file format. No React, no IO.
 */

/** The version this build writes, and the newest it can read. */
export const COLLECTION_FORMAT_VERSION = 1;

/** What collection files are called, so they're easy to find in a repository. */
export const COLLECTION_SUFFIX = ".spec0-collection.yaml";

/** An API a collection's steps come from: enough to find it again on another machine. */
export interface CollectionApi {
  title: string;
  /**
   * Where the spec comes from, as the library records it. In memory a file path
   * is the library's own (absolute) path; in a collection file saved to a
   * folder it is written relative to that file, so the pair can live in one
   * repository and still resolve on a colleague's machine.
   */
  source: { kind: SourceKind; ref: string };
  /** The spec0 API it was published as, when known. Another way to find it. */
  spec0ApiId?: string;
}

/**
 * Where a step sends its request.
 *
 * A discriminated union so a new kind of destination (a mock running on this
 * machine, for example) is a new case rather than a new field. `local-mock` is
 * part of the format already; Studio says it isn't available until it is.
 */
export type StepTarget =
  | { kind: "server"; url: string }
  | { kind: "mock" }
  | { kind: "local-mock" }
  | { kind: "custom"; url: string };

/** How a step names its operation: the id first, method and path when the id is missing or gone. */
export interface StepOperationRef {
  operationId?: string;
  method: string;
  path: string;
}

/**
 * The auth scheme a step uses, and a reference to its value.
 *
 * The value is meant to be a `{{variable}}` from an environment. A literal is
 * never written to a collection file; see {@link serializeCollection}.
 */
export interface StepAuth {
  scheme: string;
  type?: string;
  httpScheme?: string;
  in?: string;
  paramName?: string;
  value: string;
}

/**
 * The status a step expects: one code (`"404"`), a class of codes (`"4XX"`),
 * or `"2XX"`, any success, which is what a step expects when it says nothing.
 */
export interface StepExpect {
  status: string;
}

/** What a step expects when it doesn't say. Never written to a file. */
export const DEFAULT_EXPECTED_STATUS = "2XX";

/** `"404"`, `"4xx"` or `"4XX"` → `"404"` / `"4XX"`; null when it isn't a status. */
export function normaliseExpectedStatus(value: string): string | null {
  const text = value.trim().toUpperCase();
  return /^[1-5](\d\d|XX)$/.test(text) ? text : null;
}

/** Whether a response status is the one a step expects. */
export function statusMatches(expected: string | undefined, status: number): boolean {
  const want = normaliseExpectedStatus(expected ?? DEFAULT_EXPECTED_STATUS) ?? DEFAULT_EXPECTED_STATUS;
  return want.endsWith("XX") ? Math.floor(status / 100) === Number(want[0]) : status === Number(want);
}

/** How the expectation reads in the interface: "any 2xx", "404", "any 4xx". */
export function describeExpected(expected: string | undefined): string {
  const want = normaliseExpectedStatus(expected ?? DEFAULT_EXPECTED_STATUS) ?? DEFAULT_EXPECTED_STATUS;
  return want.endsWith("XX") ? `any ${want[0]}xx` : want;
}

/** The step's expected status, or undefined when it is the default. */
export function expectedStatusOf(step: Pick<CollectionStep, "expect">): string | undefined {
  const want = step.expect ? normaliseExpectedStatus(step.expect.status) : null;
  return want && want !== DEFAULT_EXPECTED_STATUS ? want : undefined;
}

export interface CollectionStep {
  /**
   * The name later steps use to refer to this one: `{{steps.<key>.body.id}}`.
   * Unique within the collection.
   */
  key: string;
  name?: string;
  /** Key into {@link Collection.apis}. Absent for an unlinked request. */
  api?: string;
  operation?: StepOperationRef;
  /**
   * A request that isn't linked to any operation, for example one brought in
   * from another tool. It runs, but nothing checks its response until it is
   * linked to an operation.
   */
  request?: { method: string; url: string };
  /** Absent means the spec's first declared server, which is what the document says. */
  target?: StepTarget;
  pathParams: Record<string, string>;
  queryParams: Record<string, string>;
  headers: Record<string, string>;
  body?: BodyInput;
  auth?: StepAuth;
  /**
   * The status this step expects. Absent means any 2xx. A step that expects
   * 404 passes on a 404 whose body matches what the spec declares for it.
   */
  expect?: StepExpect;
  /**
   * Something to know about this step that the step itself can't say, e.g.
   * that it came from Postman with a script Studio doesn't run.
   */
  note?: string;
}

export interface CollectionFileLink {
  /** Absolute path of the `.spec0-collection.yaml` file. */
  path: string;
  /** Hash of the file's text when Studio last read or wrote it. */
  syncedHash: string;
  /** Edited in Studio since then and not saved to the file yet. */
  dirty: boolean;
}

export interface Collection {
  id: string;
  name: string;
  description?: string;
  apis: Record<string, CollectionApi>;
  steps: CollectionStep[];
  /** Stop at the first failing step. On unless the user turns it off. */
  stopOnFailure: boolean;
  updatedAt: string;
  /** Set when the collection lives in a file in a folder, e.g. a git repository. */
  file?: CollectionFileLink;
}

export function newCollectionId(): string {
  return `col_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function newCollection(name: string): Collection {
  return {
    id: newCollectionId(),
    name: name.trim() || "Untitled collection",
    apis: {},
    steps: [],
    stopOnFailure: true,
    updatedAt: new Date().toISOString(),
  };
}

// ── step keys ─────────────────────────────────────────────────────────────────

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export function isValidStepKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

/** `createOrder`, or `postOrdersOrderId` for an operation with no id. */
export function baseStepKey(op: { operationId?: string; method: string; path: string }): string {
  const fromId = (op.operationId ?? "").replace(/[^A-Za-z0-9_-]/g, "");
  if (fromId && /^[A-Za-z_]/.test(fromId)) return fromId;
  const words = `${op.method} ${op.path}`
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word, index) =>
      index === 0 ? word.toLowerCase() : word[0].toUpperCase() + word.slice(1).toLowerCase(),
    );
  const joined = words.join("");
  return /^[A-Za-z_]/.test(joined) ? joined : `step${joined}`;
}

/** `base`, or `base2`, `base3`… so no two steps share a key. */
export function uniqueStepKey(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const clean = isValidStepKey(base) ? base : "step";
  if (!used.has(clean)) return clean;
  for (let n = 2; ; n += 1) if (!used.has(`${clean}${n}`)) return `${clean}${n}`;
}

// ── paths, for collections saved next to their specs ──────────────────────────

function separatorOf(path: string): "/" | "\\" {
  return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

function segments(path: string): string[] {
  return path.split(/[\\/]+/);
}

/** The folder a file is in. */
export function dirOf(path: string): string {
  const sep = separatorOf(path);
  const parts = segments(path);
  parts.pop();
  return parts.join(sep) || sep;
}

function isAbsolute(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(path);
}

/**
 * `target` written relative to the folder `fromDir`, with forward slashes so the
 * file reads the same on every OS. Null when there is no relative route, e.g.
 * another drive on Windows.
 */
export function relativePath(fromDir: string, target: string): string | null {
  if (!isAbsolute(fromDir) || !isAbsolute(target)) return null;
  const from = segments(fromDir).filter(Boolean);
  const to = segments(target).filter(Boolean);
  // Windows drive letters must agree, case-insensitively.
  const drive = (parts: string[]) => (/^[A-Za-z]:$/.test(parts[0] ?? "") ? parts[0].toLowerCase() : "");
  if (drive(from) !== drive(to)) return null;
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common += 1;
  const up = from.slice(common).map(() => "..");
  const rest = to.slice(common);
  const joined = [...up, ...rest].join("/");
  return joined.startsWith("..") ? joined : `./${joined}`;
}

/** A path from a collection file, made absolute against the folder the file is in. */
export function resolvePath(fromDir: string, ref: string): string {
  if (isAbsolute(ref)) return ref;
  const sep = separatorOf(fromDir);
  const parts = segments(fromDir);
  for (const part of segments(ref)) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length > 1) parts.pop();
    } else parts.push(part);
  }
  return parts.join(sep);
}

// ── secrets ───────────────────────────────────────────────────────────────────

const REFERENCE = /\{\{\s*[\w.-]+\s*\}\}/;

/**
 * Take secret values out of a step before it is stored or written.
 *
 * Known secret values are swapped for their `{{name}}` reference everywhere, as
 * history does. An auth value with no reference in it at all is a literal
 * credential typed into the step; it is left out rather than written down, and
 * the returned warning says so.
 */
export function redactStep(step: CollectionStep): { step: CollectionStep; dropped: boolean } {
  const map = (values: Record<string, string>) =>
    Object.fromEntries(Object.entries(values).map(([k, v]) => [k, redact(v)]));
  let body: BodyInput | undefined = step.body;
  if (typeof body === "string") body = redact(body);
  else if (body?.kind === "form") {
    body = { kind: "form", fields: body.fields.map((f) => ({ key: f.key, value: redact(f.value) })) };
  } else if (body?.kind === "multipart") {
    body = {
      kind: "multipart",
      parts: body.parts.map((p) => (p.value === undefined ? p : { ...p, value: redact(p.value) })),
    };
  }
  let auth = step.auth;
  let dropped = false;
  if (auth) {
    const value = redact(auth.value);
    if (value && !REFERENCE.test(value)) {
      dropped = true;
      auth = { ...auth, value: "" };
    } else auth = { ...auth, value };
  }
  return {
    step: {
      ...step,
      ...(step.request ? { request: { ...step.request, url: redact(step.request.url) } } : {}),
      ...(step.target?.kind === "custom" ? { target: { kind: "custom", url: redact(step.target.url) } } : {}),
      pathParams: map(step.pathParams),
      queryParams: map(step.queryParams),
      headers: redactHeaders(step.headers),
      body,
      auth,
    },
    dropped,
  };
}

// ── the file format ───────────────────────────────────────────────────────────

/**
 * What a collection file looks like. Written by {@link serializeCollection}.
 *
 * ```yaml
 * version: 1
 * name: Checkout
 * apis:
 *   orders:
 *     title: Orders API
 *     file: ../specs/orders.yaml
 * steps:
 *   - key: createOrder
 *     api: orders
 *     operationId: createOrder
 *     method: POST
 *     path: /orders
 *     body: |
 *       { "customerId": "cus_1" }
 *   - key: getOrder
 *     api: orders
 *     operationId: getOrder
 *     method: GET
 *     path: /orders/{orderId}
 *     target: mock
 *     pathParams:
 *       orderId: "{{steps.createOrder.body.id}}"
 *   - key: getDeletedOrder
 *     api: orders
 *     operationId: getOrder
 *     method: GET
 *     path: /orders/{orderId}
 *     pathParams:
 *       orderId: "{{steps.createOrder.body.id}}"
 *     expect:
 *       status: "404"
 * ```
 *
 * `expect` is written only when a step expects something other than any 2xx,
 * and `note` only when a step has one; both are optional in version 1.
 *
 * Empty maps are left out so a diff shows only what someone changed.
 */
interface FileApi {
  title: string;
  file?: string;
  url?: string;
  spec0?: string;
  sample?: true;
  spec0ApiId?: string;
}

type FileTarget = "mock" | "local-mock" | { server: string } | { url: string };

interface FileStep {
  key: string;
  name?: string;
  api?: string;
  operationId?: string;
  method: string;
  path?: string;
  url?: string;
  target?: FileTarget;
  pathParams?: Record<string, string>;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  auth?: StepAuth;
  body?: string;
  form?: Array<{ name: string; value: string }>;
  multipart?: Array<{ name: string; value?: string; file?: string; contentType?: string }>;
  expect?: { status: string };
  note?: string;
}

interface FileShape {
  version: number;
  name: string;
  description?: string;
  run?: { stopOnFailure: boolean };
  apis?: Record<string, FileApi>;
  steps?: FileStep[];
}

export interface SerializeOptions {
  /** Absolute path of the file being written. File sources are written relative to it. */
  filePath?: string;
}

/** Where a file-backed API's spec is, as the file should record it. */
function fileRef(ref: string, filePath: string | undefined): string {
  if (!filePath) return ref;
  return relativePath(dirOf(filePath), ref) ?? ref;
}

function nonEmpty<T extends object>(value: T | undefined): T | undefined {
  return value && Object.keys(value).length ? value : undefined;
}

function toFileTarget(target: StepTarget | undefined): FileTarget | undefined {
  if (!target) return undefined;
  switch (target.kind) {
    case "mock":
      return "mock";
    case "local-mock":
      return "local-mock";
    case "server":
      return { server: target.url };
    case "custom":
      return { url: target.url };
  }
}

/**
 * Write a collection as YAML.
 *
 * Secret values are replaced with their `{{references}}`, and literal auth
 * values are left out; `warnings` says when that happened, so an export can tell
 * the user what they'll need to fill in.
 */
export function serializeCollection(
  collection: Collection,
  options: SerializeOptions = {},
): { text: string; warnings: string[] } {
  const warnings: string[] = [];
  const apis: Record<string, FileApi> = {};
  for (const [key, api] of Object.entries(collection.apis)) {
    const out: FileApi = { title: api.title };
    if (api.source.kind === "file") out.file = fileRef(api.source.ref, options.filePath);
    else if (api.source.kind === "url") out.url = api.source.ref;
    else if (api.source.kind === "spec0") out.spec0 = api.source.ref.replace(/^spec0:/, "");
    else out.sample = true;
    if (api.spec0ApiId) out.spec0ApiId = api.spec0ApiId;
    apis[key] = out;
  }

  const steps: FileStep[] = collection.steps.map((raw) => {
    const { step, dropped } = redactStep(raw);
    if (dropped) {
      warnings.push(
        `${step.key}: the auth value wasn't a {{variable}}, so it was left out. Put it in an environment and refer to it.`,
      );
    }
    const out: FileStep = {
      key: step.key,
      ...(step.name ? { name: step.name } : {}),
      ...(step.api ? { api: step.api } : {}),
      ...(step.operation?.operationId ? { operationId: step.operation.operationId } : {}),
      method: (step.operation?.method ?? step.request?.method ?? "GET").toUpperCase(),
      ...(step.operation ? { path: step.operation.path } : {}),
      ...(!step.operation && step.request ? { url: step.request.url } : {}),
    };
    const target = toFileTarget(step.target);
    if (target) out.target = target;
    const pathParams = nonEmpty(step.pathParams);
    if (pathParams) out.pathParams = pathParams;
    const query = nonEmpty(step.queryParams);
    if (query) out.query = query;
    const headers = nonEmpty(step.headers);
    if (headers) out.headers = headers;
    if (step.auth && (step.auth.scheme || step.auth.value)) {
      out.auth = Object.fromEntries(
        Object.entries(step.auth).filter(([, v]) => v !== undefined && v !== ""),
      ) as unknown as StepAuth;
      if (!out.auth.value) out.auth.value = "";
    }
    if (typeof step.body === "string") {
      if (step.body.trim()) out.body = step.body.endsWith("\n") ? step.body : `${step.body}\n`;
    } else if (step.body?.kind === "form") {
      if (step.body.fields.length) out.form = step.body.fields.map((f) => ({ name: f.key, value: f.value }));
    } else if (step.body?.kind === "multipart") {
      if (step.body.parts.length) {
        out.multipart = step.body.parts.map((p) => ({
          name: p.name,
          ...(p.path ? { file: p.path } : { value: p.value ?? "" }),
          ...(p.contentType ? { contentType: p.contentType } : {}),
        }));
      }
    }
    const expected = expectedStatusOf(step);
    if (expected) out.expect = { status: expected };
    if (step.note?.trim()) out.note = step.note;
    return out;
  });

  const shape: FileShape = {
    version: COLLECTION_FORMAT_VERSION,
    name: collection.name,
    ...(collection.description ? { description: collection.description } : {}),
    ...(collection.stopOnFailure ? {} : { run: { stopOnFailure: false } }),
    apis,
    steps,
  };
  const header =
    "# A spec0 Studio collection. Each step points at an operation in one of the\n" +
    "# specs under `apis`; the spec stays the source of truth. Values like\n" +
    "# {{token}} come from a Studio environment and are never stored here.\n";
  const text = header + dump(shape, { lineWidth: 100, noRefs: true, quotingType: '"' });
  return { text, warnings };
}

export class CollectionFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CollectionFormatError";
  }
}

function stringMap(value: unknown, where: string): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new CollectionFormatError(`${where} must be a map of names to values.`);
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, v === null ? "" : String(v)]),
  );
}

function parseTarget(value: unknown, where: string): StepTarget | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "mock") return { kind: "mock" };
  if (value === "local-mock") return { kind: "local-mock" };
  if (typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.server === "string") return { kind: "server", url: record.server };
    if (typeof record.url === "string") return { kind: "custom", url: record.url };
  }
  throw new CollectionFormatError(
    `${where}: target must be "mock", "local-mock", { server: <url> } or { url: <url> }.`,
  );
}

export interface ParseOptions {
  /** Absolute path the text was read from. Relative spec paths resolve against it. */
  filePath?: string;
  /** Keep this id, e.g. when reloading a collection Studio already has. */
  id?: string;
}

/**
 * Read a collection file.
 *
 * Throws {@link CollectionFormatError} with a message a person can act on: the
 * file is from a newer Studio, a step has no key, two steps share one, and so on.
 */
export function parseCollection(text: string, options: ParseOptions = {}): Collection {
  let raw: unknown;
  try {
    raw = load(text);
  } catch (error) {
    throw new CollectionFormatError(
      `This isn't valid YAML: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
    );
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CollectionFormatError("A collection file must be a YAML map.");
  }
  const file = raw as Partial<FileShape> & Record<string, unknown>;
  if (typeof file.version !== "number") {
    throw new CollectionFormatError("No `version` — is this a spec0 Studio collection?");
  }
  if (file.version > COLLECTION_FORMAT_VERSION) {
    throw new CollectionFormatError(
      `This collection is format version ${file.version}; this Studio reads up to ${COLLECTION_FORMAT_VERSION}. Update Studio to open it.`,
    );
  }
  if (file.version < 1) throw new CollectionFormatError(`Unknown collection version ${file.version}.`);

  const dir = options.filePath ? dirOf(options.filePath) : undefined;
  const apis: Record<string, CollectionApi> = {};
  for (const [key, value] of Object.entries(file.apis ?? {})) {
    const api = (value ?? {}) as FileApi;
    const title = typeof api.title === "string" ? api.title : key;
    let source: CollectionApi["source"];
    if (typeof api.file === "string") source = { kind: "file", ref: dir ? resolvePath(dir, api.file) : api.file };
    else if (typeof api.url === "string") source = { kind: "url", ref: api.url };
    else if (typeof api.spec0 === "string") source = { kind: "spec0", ref: `spec0:${api.spec0}` };
    else if (api.sample) source = { kind: "sample", ref: "sample" };
    else throw new CollectionFormatError(`API "${key}" needs a file, url or spec0 source.`);
    apis[key] = { title, source, ...(typeof api.spec0ApiId === "string" ? { spec0ApiId: api.spec0ApiId } : {}) };
  }

  if (file.steps !== undefined && !Array.isArray(file.steps)) {
    throw new CollectionFormatError("`steps` must be a list.");
  }
  const seen = new Set<string>();
  const steps: CollectionStep[] = (file.steps ?? []).map((value, index) => {
    const where = `Step ${index + 1}`;
    if (!value || typeof value !== "object") throw new CollectionFormatError(`${where} is empty.`);
    const s = value as FileStep;
    if (typeof s.key !== "string" || !isValidStepKey(s.key)) {
      throw new CollectionFormatError(
        `${where} needs a key made of letters, digits, - and _, starting with a letter.`,
      );
    }
    if (seen.has(s.key)) throw new CollectionFormatError(`Two steps share the key "${s.key}".`);
    seen.add(s.key);
    if (s.api !== undefined && !apis[s.api]) {
      throw new CollectionFormatError(`Step "${s.key}" uses API "${s.api}", which isn't listed under apis.`);
    }
    const method = String(s.method ?? "GET").toUpperCase();
    let operation: StepOperationRef | undefined;
    let request: CollectionStep["request"];
    if (s.api) {
      if (typeof s.path !== "string") throw new CollectionFormatError(`Step "${s.key}" needs a path.`);
      operation = {
        ...(typeof s.operationId === "string" ? { operationId: s.operationId } : {}),
        method,
        path: s.path,
      };
    } else {
      if (typeof s.url !== "string") {
        throw new CollectionFormatError(`Step "${s.key}" has no api, so it needs a url.`);
      }
      request = { method, url: s.url };
    }
    let body: BodyInput | undefined;
    if (typeof s.body === "string") body = s.body;
    else if (Array.isArray(s.form)) {
      body = { kind: "form", fields: s.form.map((f) => ({ key: String(f.name ?? ""), value: String(f.value ?? "") })) };
    } else if (Array.isArray(s.multipart)) {
      body = {
        kind: "multipart",
        parts: s.multipart.map(
          (p): MultipartPart => ({
            name: String(p.name ?? ""),
            ...(typeof p.file === "string" ? { path: p.file, fileName: p.file.split(/[\\/]/).pop() } : { value: String(p.value ?? "") }),
            ...(p.contentType ? { contentType: String(p.contentType) } : {}),
          }),
        ),
      };
    }
    let expect: CollectionStep["expect"];
    if (s.expect !== undefined && s.expect !== null) {
      const raw = typeof s.expect === "object" ? (s.expect as { status?: unknown }).status : s.expect;
      const status = normaliseExpectedStatus(String(raw ?? ""));
      if (!status) {
        throw new CollectionFormatError(
          `Step "${s.key}": expect.status must be a status like "404", or a range like "4XX".`,
        );
      }
      if (status !== DEFAULT_EXPECTED_STATUS) expect = { status };
    }
    const auth =
      s.auth && typeof s.auth === "object"
        ? ({ ...s.auth, scheme: String(s.auth.scheme ?? ""), value: String(s.auth.value ?? "") } as StepAuth)
        : undefined;
    return {
      key: s.key,
      ...(typeof s.name === "string" && s.name ? { name: s.name } : {}),
      ...(s.api ? { api: s.api } : {}),
      ...(operation ? { operation } : {}),
      ...(request ? { request } : {}),
      ...(s.target !== undefined ? { target: parseTarget(s.target, `Step "${s.key}"`) } : {}),
      pathParams: stringMap(s.pathParams, `Step "${s.key}" pathParams`),
      queryParams: stringMap(s.query, `Step "${s.key}" query`),
      headers: stringMap(s.headers, `Step "${s.key}" headers`),
      ...(body !== undefined ? { body } : {}),
      ...(auth ? { auth } : {}),
      ...(expect ? { expect } : {}),
      ...(typeof s.note === "string" && s.note.trim() ? { note: s.note.replace(/\n$/, "") } : {}),
    };
  });

  return {
    id: options.id ?? newCollectionId(),
    name: typeof file.name === "string" && file.name.trim() ? file.name : "Untitled collection",
    ...(typeof file.description === "string" ? { description: file.description } : {}),
    apis,
    steps,
    stopOnFailure: file.run?.stopOnFailure !== false,
    updatedAt: new Date().toISOString(),
  };
}

/** The hash used to notice that a collection file changed on disk. */
export function textHash(text: string): string {
  return fingerprint(text);
}

/** A file name for exporting: `checkout-flow.spec0-collection.yaml`. */
export function suggestedCollectionFileName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "collection"}${COLLECTION_SUFFIX}`;
}

// ── editing ───────────────────────────────────────────────────────────────────

/** Move a step from one position to another, the way drag and Alt+arrow both do. */
export function moveStep(collection: Collection, from: number, to: number): Collection {
  if (from === to || from < 0 || from >= collection.steps.length) return collection;
  const clamped = Math.max(0, Math.min(collection.steps.length - 1, to));
  const steps = [...collection.steps];
  const [moved] = steps.splice(from, 1);
  steps.splice(clamped, 0, moved);
  return { ...collection, steps };
}

/**
 * Rename a step's key, and every reference to it in the other steps, so a
 * rename can't quietly break a later step.
 */
export function renameStepKey(collection: Collection, from: string, to: string): Collection {
  if (from === to) return collection;
  if (!isValidStepKey(to)) throw new Error("A step key uses letters, digits, - and _, starting with a letter.");
  if (collection.steps.some((s) => s.key === to)) throw new Error(`Another step is already called "${to}".`);
  const pattern = new RegExp(`(\\{\\{\\s*steps\\.)${from.replace(/[-]/g, "\\-")}(?=[.\\s}\\[])`, "g");
  const swap = (text: string) => text.replace(pattern, `$1${to}`);
  const swapMap = (values: Record<string, string>) =>
    Object.fromEntries(Object.entries(values).map(([k, v]) => [k, swap(v)]));
  return {
    ...collection,
    steps: collection.steps.map((step) => {
      let body = step.body;
      if (typeof body === "string") body = swap(body);
      else if (body?.kind === "form") body = { ...body, fields: body.fields.map((f) => ({ ...f, value: swap(f.value) })) };
      else if (body?.kind === "multipart") {
        body = { ...body, parts: body.parts.map((p) => (p.value === undefined ? p : { ...p, value: swap(p.value) })) };
      }
      return {
        ...step,
        key: step.key === from ? to : step.key,
        pathParams: swapMap(step.pathParams),
        queryParams: swapMap(step.queryParams),
        headers: swapMap(step.headers),
        body,
        ...(step.request ? { request: { ...step.request, url: swap(step.request.url) } } : {}),
        ...(step.auth ? { auth: { ...step.auth, value: swap(step.auth.value) } } : {}),
      };
    }),
  };
}
