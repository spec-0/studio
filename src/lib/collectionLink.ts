import {
  baseStepKey,
  uniqueStepKey,
  type Collection,
  type CollectionApi,
  type CollectionStep,
  type StepTarget,
} from "./collection";
import { exampleBody, exampleParam } from "./example";
import { paramsFromEntry } from "./history";
import { spec0ApiIdOf, type LibraryEntry } from "./library";
import type { BodyInput } from "./request";
import { bodyModeFor, deref, type OperationSpec, type ParsedSpec } from "./spec";

/**
 * How a collection's steps meet the specs they point at: finding each API in the
 * library, finding each operation in its spec, noticing when a step no longer
 * matches, and working out where a step's request goes.
 */

// ── finding the API ───────────────────────────────────────────────────────────

const normalise = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "");
const baseName = (path: string) => normalise(path).split("/").pop() ?? path;

/**
 * The library entry a collection's API refers to, or null.
 *
 * Tried in order of certainty: the same source; the same Spec0 API; and, for a
 * file, the same file name *and* the same title — a file added to the library
 * by dragging it in has no full path to compare. A title on its own is never
 * enough: two unrelated specs can share one, and a step silently checked
 * against the wrong spec is worse than one that says it can't find its spec.
 */
export function findLibraryEntry(api: CollectionApi, entries: readonly LibraryEntry[]): LibraryEntry | null {
  const exact = entries.find(
    (entry) =>
      entry.source.kind === api.source.kind &&
      (entry.source.kind === "file"
        ? normalise(entry.source.ref) === normalise(api.source.ref)
        : entry.source.ref === api.source.ref),
  );
  if (exact) return exact;
  if (api.spec0ApiId || api.source.kind === "spec0") {
    const wanted = api.spec0ApiId ?? api.source.ref.replace(/^spec0:/, "");
    const linked = entries.find((entry) => spec0ApiIdOf(entry) === wanted);
    if (linked) return linked;
  }
  if (api.source.kind === "file") {
    const named = entries.filter(
      (entry) =>
        entry.source.kind === "file" &&
        baseName(entry.source.ref) === baseName(api.source.ref) &&
        entry.title === api.title,
    );
    if (named.length === 1) return named[0];
  }
  return null;
}

/** What a collection records about a library entry. */
export function apiFromEntry(entry: LibraryEntry): CollectionApi {
  const spec0ApiId = spec0ApiIdOf(entry);
  return {
    title: entry.title,
    source: { ...entry.source },
    ...(spec0ApiId && entry.source.kind !== "spec0" ? { spec0ApiId } : {}),
  };
}

/** The key a collection already uses for this entry, or a new readable one. */
export function apiKeyFor(collection: Collection, entry: LibraryEntry): { key: string; added: boolean } {
  for (const [key, api] of Object.entries(collection.apis)) {
    if (findLibraryEntry(api, [entry])) return { key, added: false };
  }
  const slug =
    entry.title
      .toLowerCase()
      .replace(/\(.*?\)/g, "")
      .replace(/\bapi\b/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "api";
  let key = slug;
  for (let n = 2; collection.apis[key]; n += 1) key = `${slug}-${n}`;
  return { key, added: true };
}

// ── finding the operation ─────────────────────────────────────────────────────

export interface FoundOperation {
  op: OperationSpec;
  /** Matched on method and path because the operationId is missing or no longer there. */
  byPath: boolean;
}

export function findOperation(
  spec: ParsedSpec,
  ref: { operationId?: string; method: string; path: string },
): FoundOperation | null {
  if (ref.operationId) {
    const byId = spec.operations.find((op) => op.operationId === ref.operationId);
    if (byId) return { op: byId, byPath: false };
  }
  const byPath = spec.operations.find(
    (op) => op.method.toUpperCase() === ref.method.toUpperCase() && op.path === ref.path,
  );
  return byPath ? { op: byPath, byPath: true } : null;
}

// ── is the step still right? ──────────────────────────────────────────────────

export type StepLink =
  | { kind: "ok"; entry: LibraryEntry; spec: ParsedSpec; op: OperationSpec }
  | { kind: "stale"; entry: LibraryEntry; spec: ParsedSpec; op: OperationSpec; reasons: string[] }
  | { kind: "unlinked" }
  | {
      kind: "unresolved";
      reason: string;
      /** The API is known and in the library; only the operation is missing. */
      entry?: LibraryEntry;
      spec?: ParsedSpec;
    }
  /** The spec is in the library but hasn't been read yet. */
  | { kind: "loading"; entry: LibraryEntry };

/** Required body fields a JSON body leaves out. Null when the body can't be read as JSON. */
function missingBodyFields(spec: ParsedSpec, op: OperationSpec, body: BodyInput | undefined): string[] | null {
  if (!op.requestBody?.schema || bodyModeFor(op.requestBody.contentType) !== "text") return null;
  const schema = deref(spec.doc, op.requestBody.schema);
  const required: string[] = Array.isArray(schema.required) ? schema.required : [];
  if (!required.length) return [];
  const text = typeof body === "string" ? body : "";
  if (!text.trim()) return op.requestBody.required ? required : [];
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return required.filter((name) => !(name in parsed));
  } catch {
    // `{{steps.x.body.count}}` left unquoted isn't JSON until it's filled in.
    return null;
  }
}

/**
 * Compare a step with the operation it points at, as the spec is now.
 *
 * Each reason is a sentence about what changed, so the marker can say it
 * rather than just "out of date".
 */
export function staleReasons(
  step: CollectionStep,
  spec: ParsedSpec,
  found: FoundOperation,
): string[] {
  const reasons: string[] = [];
  const { op } = found;
  const ref = step.operation;
  if (ref) {
    if (found.byPath && ref.operationId) {
      reasons.push(
        op.operationId
          ? `The operation id changed from ${ref.operationId} to ${op.operationId}.`
          : `The operation no longer has the id ${ref.operationId}.`,
      );
    }
    if (!found.byPath && (op.method.toUpperCase() !== ref.method.toUpperCase() || op.path !== ref.path)) {
      reasons.push(`${ref.operationId} is now ${op.method} ${op.path} (was ${ref.method.toUpperCase()} ${ref.path}).`);
    }
  }
  const declared = (where: "path" | "query") =>
    new Set(op.parameters.filter((p) => p.in === where).map((p) => p.name));
  for (const [where, values] of [
    ["path", step.pathParams],
    ["query", step.queryParams],
  ] as const) {
    const names = declared(where);
    for (const name of Object.keys(values)) {
      if (!names.has(name)) reasons.push(`The ${where} parameter ${name} is no longer in the spec.`);
    }
  }
  for (const param of op.parameters) {
    if (!param.required || param.in === "cookie") continue;
    const bag = param.in === "path" ? step.pathParams : param.in === "query" ? step.queryParams : step.headers;
    const has = Object.keys(bag).some((name) =>
      param.in === "header" ? name.toLowerCase() === param.name.toLowerCase() : name === param.name,
    );
    if (!has) reasons.push(`The spec now requires the ${param.in} parameter ${param.name}.`);
  }
  const missing = missingBodyFields(spec, op, step.body);
  if (missing?.length) {
    reasons.push(
      `The body has no ${missing.map((name) => `\`${name}\``).join(", ")}, which the spec requires.`,
    );
  }
  if (step.target?.kind === "server" && spec.servers.length && !spec.servers.includes(step.target.url)) {
    reasons.push(`The spec no longer declares the server ${step.target.url}.`);
  }
  return reasons;
}

/**
 * Where a step stands against the library and its spec.
 *
 * `specs` holds the parsed specs Studio has read so far, by library id; an
 * entry that isn't in it yet is "loading", not "missing".
 */
export function linkStep(
  step: CollectionStep,
  collection: Collection,
  entries: readonly LibraryEntry[],
  specs: ReadonlyMap<string, ParsedSpec | null>,
): StepLink {
  if (!step.api) return { kind: "unlinked" };
  const api = collection.apis[step.api];
  if (!api) return { kind: "unresolved", reason: `The API "${step.api}" isn't listed in this collection.` };
  const entry = findLibraryEntry(api, entries);
  if (!entry) {
    return { kind: "unresolved", reason: `${api.title} isn't in your library. Add it, or link this step to another operation.` };
  }
  if (!specs.has(entry.id)) return { kind: "loading", entry };
  const spec = specs.get(entry.id) ?? null;
  if (!spec) return { kind: "unresolved", reason: `Studio couldn't read ${entry.title}.`, entry };
  if (!step.operation) return { kind: "unresolved", reason: "This step doesn't name an operation.", entry, spec };
  const found = findOperation(spec, step.operation);
  if (!found) {
    const name = step.operation.operationId ?? `${step.operation.method} ${step.operation.path}`;
    return {
      kind: "unresolved",
      reason: `${name} is no longer in ${entry.title}. Link this step to an operation to keep using it.`,
      entry,
      spec,
    };
  }
  const reasons = staleReasons(step, spec, found);
  return reasons.length
    ? { kind: "stale", entry, spec, op: found.op, reasons }
    : { kind: "ok", entry, spec, op: found.op };
}

// ── making steps ──────────────────────────────────────────────────────────────

/** Values a new step starts from; missing ones are generated from the schema. */
export interface StepValues {
  pathParams?: Record<string, string>;
  queryParams?: Record<string, string>;
  headers?: Record<string, string>;
  body?: BodyInput;
}

/**
 * Headers Studio sets itself when it builds a request, or that belong to a
 * target rather than a step. Left out when a step is made from a recorded
 * request, or they'd be sent twice or pinned to one mock's key.
 */
const MANAGED_HEADERS = new Set(["content-type", "accept", "x-mock-api-key", "cookie", "content-length", "host"]);

export function stepValuesFromHistory(
  entry: { url: string; headers: Record<string, string>; body?: string; bodyKind?: string },
  op: OperationSpec,
): StepValues {
  const { pathParams, queryParams: sent } = paramsFromEntry(entry, op.path);
  // Only what the operation declares: an API key the auth scheme put in the
  // query belongs to the auth, not to the step.
  const declared = new Set(op.parameters.filter((p) => p.in === "query").map((p) => p.name));
  const queryParams = Object.fromEntries(Object.entries(sent).filter(([name]) => declared.has(name)));
  const headers = Object.fromEntries(
    Object.entries(entry.headers).filter(([name]) => !MANAGED_HEADERS.has(name.toLowerCase())),
  );
  return {
    pathParams,
    queryParams,
    headers,
    ...(entry.body !== undefined && (entry.bodyKind ?? "text") === "text" ? { body: entry.body } : {}),
  };
}

/**
 * A new step for an operation.
 *
 * Without values, parameters start as the operation editor starts them:
 * required ones get an example from the schema, optional ones are left out.
 */
export function stepForOperation(
  collection: Collection,
  apiKey: string,
  spec: ParsedSpec,
  op: OperationSpec,
  values: StepValues = {},
  target?: StepTarget,
): CollectionStep {
  const seed = (where: "path" | "query" | "header") =>
    Object.fromEntries(
      op.parameters
        .filter((p) => p.in === where && p.required)
        .map((p) => [p.name, exampleParam(spec.doc, p.schema, p.name)]),
    );
  const body: BodyInput | undefined =
    values.body ??
    (op.requestBody
      ? bodyModeFor(op.requestBody.contentType) === "text"
        ? exampleBody(spec.doc, op.requestBody.schema)
        : undefined
      : undefined);
  return {
    key: uniqueStepKey(baseStepKey(op), collection.steps.map((s) => s.key)),
    api: apiKey,
    operation: {
      ...(op.operationId ? { operationId: op.operationId } : {}),
      method: op.method,
      path: op.path,
    },
    ...(target ? { target } : {}),
    pathParams: values.pathParams ?? seed("path"),
    queryParams: values.queryParams ?? seed("query"),
    headers: values.headers ?? seed("header"),
    ...(body !== undefined && body !== "" ? { body } : {}),
  };
}

/** Add an operation from a library entry as the last step. */
export function addOperationStep(
  collection: Collection,
  entry: LibraryEntry,
  spec: ParsedSpec,
  op: OperationSpec,
  values?: StepValues,
  target?: StepTarget,
): Collection {
  const { key, added } = apiKeyFor(collection, entry);
  const apis = added ? { ...collection.apis, [key]: apiFromEntry(entry) } : collection.apis;
  const withApi = { ...collection, apis };
  const step = stepForOperation(withApi, key, spec, op, values, target);
  return { ...withApi, steps: [...collection.steps, step] };
}

/**
 * Point a step at another operation, keeping its inputs.
 *
 * Used for "Link to an operation…": a step whose operation disappeared, or an
 * unlinked request brought in from elsewhere. Inputs the new operation doesn't
 * declare are dropped so the step isn't immediately marked stale for them; an
 * unlinked request's path values are read from its URL.
 */
export function relinkStep(
  collection: Collection,
  index: number,
  entry: LibraryEntry,
  op: OperationSpec,
): Collection {
  const step = collection.steps[index];
  if (!step) return collection;
  const { key, added } = apiKeyFor(collection, entry);
  const apis = { ...(added ? { ...collection.apis, [key]: apiFromEntry(entry) } : collection.apis) };
  const keep = (where: "path" | "query", values: Record<string, string>) => {
    const names = new Set(op.parameters.filter((p) => p.in === where).map((p) => p.name));
    return Object.fromEntries(Object.entries(values).filter(([name]) => names.has(name)));
  };
  const fromUrl = step.request ? paramsFromEntry({ url: step.request.url.replace(/\{\{[^}]*\}\}/, "http://x") }, op.path) : null;
  const relinked: CollectionStep = {
    key: step.key,
    ...(step.name ? { name: step.name } : {}),
    api: key,
    operation: { ...(op.operationId ? { operationId: op.operationId } : {}), method: op.method, path: op.path },
    ...(step.target && step.target.kind !== "server" ? { target: step.target } : {}),
    pathParams: keep("path", { ...(fromUrl?.pathParams ?? {}), ...step.pathParams }),
    queryParams: keep("query", { ...(fromUrl?.queryParams ?? {}), ...step.queryParams }),
    headers: step.headers,
    ...(step.body !== undefined ? { body: step.body } : {}),
    ...(step.auth ? { auth: step.auth } : {}),
  };
  const steps = collection.steps.map((s, i) => (i === index ? relinked : s));
  // An API no step uses any more is dropped, so the file doesn't collect them.
  const used = new Set(steps.map((s) => s.api).filter(Boolean));
  for (const name of Object.keys(apis)) if (!used.has(name)) delete apis[name];
  return { ...collection, apis, steps };
}

/** Remove a step, and its API if no other step uses it. */
export function removeStep(collection: Collection, index: number): Collection {
  const steps = collection.steps.filter((_, i) => i !== index);
  const used = new Set(steps.map((s) => s.api).filter(Boolean));
  const apis = Object.fromEntries(Object.entries(collection.apis).filter(([name]) => used.has(name)));
  return { ...collection, steps, apis };
}

// ── where a step's request goes ───────────────────────────────────────────────

export interface TargetOption {
  target: StepTarget;
  label: string;
}

/**
 * What a step's target picker offers: the spec's servers, then the API's hosted
 * mock when it has one. A mock running on this machine will join the list when
 * Studio can start one; a typed URL is always available.
 */
export function targetOptions(spec: ParsedSpec | null, mockUrl: string | null): TargetOption[] {
  const options: TargetOption[] = (spec?.servers ?? []).map((url) => ({
    target: { kind: "server", url },
    label: url,
  }));
  if (mockUrl) options.push({ target: { kind: "mock" }, label: "Hosted mock" });
  return options;
}

/** The target a new step gets from the address bar it was added from. */
export function targetFromAddress(address: string, spec: ParsedSpec, mockUrl: string | null): StepTarget | undefined {
  const trimmed = address.trim().replace(/\/$/, "");
  if (!trimmed) return undefined;
  if (mockUrl && trimmed === mockUrl.replace(/\/$/, "")) return { kind: "mock" };
  if (trimmed === (spec.servers[0] ?? "").replace(/\/$/, "")) return undefined;
  const declared = spec.servers.find((url) => url.replace(/\/$/, "") === trimmed);
  return declared ? { kind: "server", url: declared } : { kind: "custom", url: address.trim() };
}

export function describeTarget(target: StepTarget | undefined, spec: ParsedSpec | null): string {
  if (!target) return spec?.servers[0] ? `${spec.servers[0]} (first server)` : "No server declared";
  switch (target.kind) {
    case "server":
      return target.url;
    case "mock":
      return "Hosted mock";
    case "local-mock":
      return "Local mock";
    case "custom":
      return target.url || "Custom URL";
  }
}

/**
 * The base URL a step's request goes to, or why there isn't one.
 *
 * `localMockUrl` is for a mock running on this machine; until Studio can run
 * one it is never given, and a step aimed there says so plainly.
 */
export function resolveTarget(
  target: StepTarget | undefined,
  context: { servers: readonly string[]; mockUrl: string | null; localMockUrl?: string | null },
): { url: string; mock: boolean } | { error: string } {
  if (!target) {
    return context.servers[0]
      ? { url: context.servers[0], mock: false }
      : { error: "The spec declares no server. Pick a target for this step." };
  }
  switch (target.kind) {
    case "server":
      return { url: target.url, mock: false };
    case "custom":
      return target.url.trim() ? { url: target.url, mock: false } : { error: "Enter a URL for this step's target." };
    case "mock":
      return context.mockUrl
        ? { url: context.mockUrl, mock: true }
        : { error: "This API has no hosted mock. Create one from the Mocks tab, or pick another target." };
    case "local-mock":
      return context.localMockUrl
        ? { url: context.localMockUrl, mock: true }
        : { error: "No local mock is running for this API. Pick another target." };
  }
}
