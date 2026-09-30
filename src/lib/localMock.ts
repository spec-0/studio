import { exampleFor, mediaExample } from "./example";
import { deref, type Json, type OperationSpec, type ParamSpec, type ParsedSpec } from "./spec";
import { validateResponse } from "./validate";

/**
 * How a local mock answers a request: which operation it is, which response to
 * send and what goes in it.
 *
 * Pure and synchronous, so every rule here is tested without a socket. Rust
 * (`src-tauri/src/local_mock.rs`) owns the socket and the Host, Origin and CORS
 * checks, and hands each request that passes them to the web view, which calls
 * {@link answerMockRequest}. Keeping the answer here means the mock uses the same
 * spec parsing and the same example rules (`example.ts`) as the request editor,
 * so what Studio pre-fills and what the mock sends back never disagree.
 */

/** A request as Rust hands it over. Header names are lower-case. */
export interface MockRequest {
  method: string;
  /** The path as received, without the query string. */
  path: string;
  /** The raw query string, without the `?`. */
  query: string;
  headers: Record<string, string>;
  body: string;
}

export interface MockResponse {
  status: number;
  headers: Array<[string, string]>;
  body: string;
}

/** What to do with a request that doesn't match the spec. */
export type InvalidRequests = "warn" | "reject";

export interface MockOptions {
  /**
   * `warn` (the default) still answers, and lists the problems in
   * `X-Spec0-Mock-Warnings`. `reject` answers 400 with the problems instead.
   * Warning is the friendlier default: a frontend half-way through building a
   * form keeps getting data back, and the header says what's off.
   */
  invalid: InvalidRequests;
}

export const DEFAULT_MOCK_OPTIONS: MockOptions = { invalid: "warn" };

/** Lists what didn't match the spec. Only set when there is something to say. */
export const WARNINGS_HEADER = "X-Spec0-Mock-Warnings";
/** Which operation answered, as `METHOD /path/{template}`. */
export const OPERATION_HEADER = "X-Spec0-Mock-Operation";
/** Ask for a status: `X-Mock-Status: 404`. `Prefer: code=404` and `?__status=404` do the same. */
export const STATUS_HEADER = "x-mock-status";
export const STATUS_QUERY = "__status";

const MAX_WARNINGS_HEADER = 1500;
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE"];

// Matching

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Match a path against an OpenAPI path template. Returns the path parameters,
 * or null. A `{name}` matches one whole, non-empty segment, or part of one
 * (`/files/{name}.json`); literal segments must match exactly.
 */
export function matchPath(template: string, path: string): Record<string, string> | null {
  const want = template.split("/");
  const got = path.split("/");
  // One trailing slash is forgiven: `/orders/` is `/orders`.
  if (got.length === want.length + 1 && got[got.length - 1] === "" && got.length > 2) got.pop();
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < want.length; index += 1) {
    const pattern = want[index];
    const segment = got[index];
    if (!pattern.includes("{")) {
      if (decode(segment) !== pattern && segment !== pattern) return null;
      continue;
    }
    const names: string[] = [];
    const source = pattern
      .split(/(\{[^}]+\})/)
      .map((part) => {
        const name = /^\{([^}]+)\}$/.exec(part)?.[1];
        if (!name) return escapeRegex(part);
        names.push(name);
        return "([^/]+?)";
      })
      .join("");
    const found = new RegExp(`^${source}$`).exec(segment);
    if (!found) return null;
    names.forEach((name, position) => {
      params[name] = decode(found[position + 1]);
    });
  }
  return params;
}

/** More literal text wins: `/orders/latest` beats `/orders/{id}` for `/orders/latest`. */
function specificity(template: string): number {
  return template.replace(/\{[^}]+\}/g, "").length;
}

/**
 * The request path, plus the same path with each server's base path removed.
 * A spec whose server is `https://api.example.com/v1` describes `/orders`, and
 * a frontend pointed at the mock may call either `/orders` or `/v1/orders`.
 */
export function candidatePaths(servers: string[], path: string): string[] {
  const out = [path];
  for (const server of servers) {
    if (server.includes("{")) continue;
    let base = server;
    try {
      base = new URL(server, "http://base.invalid").pathname;
    } catch {
      continue;
    }
    base = base.replace(/\/+$/, "");
    if (!base) continue;
    if (path === base) out.push("/");
    else if (path.startsWith(`${base}/`)) out.push(path.slice(base.length));
  }
  return [...new Set(out)];
}

export type Match =
  | { kind: "found"; op: OperationSpec; params: Record<string, string>; head: boolean }
  | { kind: "method"; allowed: string[] }
  | { kind: "none"; closest: string[] };

/** Find the operation for a method and path. */
export function matchOperation(spec: ParsedSpec, method: string, path: string): Match {
  const upper = method.toUpperCase();
  const allowed = new Set<string>();
  for (const candidate of candidatePaths(spec.servers, path)) {
    const hits = spec.operations
      .map((op) => ({ op, params: matchPath(op.path, candidate) }))
      .filter((hit): hit is { op: OperationSpec; params: Record<string, string> } => hit.params !== null)
      .sort((a, b) => specificity(b.op.path) - specificity(a.op.path));
    if (!hits.length) continue;
    // The most specific template decides which path this is; only its methods count.
    const bestPath = hits[0].op.path;
    const onPath = hits.filter((hit) => hit.op.path === bestPath);
    const exact = onPath.find((hit) => hit.op.method === upper);
    if (exact) return { kind: "found", op: exact.op, params: exact.params, head: false };
    // HEAD is GET without a body, as HTTP says, unless the spec declares its own.
    const get = upper === "HEAD" ? onPath.find((hit) => hit.op.method === "GET") : undefined;
    if (get) return { kind: "found", op: get.op, params: get.params, head: true };
    for (const hit of onPath) allowed.add(hit.op.method);
    if (allowed.has("GET")) allowed.add("HEAD");
    return { kind: "method", allowed: METHODS.filter((m) => allowed.has(m)) };
  }
  return { kind: "none", closest: closestOperations(spec, path) };
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}

/** Up to three operations whose path is nearest to the one asked for. */
export function closestOperations(spec: ParsedSpec, path: string, limit = 3): string[] {
  const candidates = candidatePaths(spec.servers, path);
  const scored = spec.operations.map((op) => {
    const distance = Math.min(
      ...candidates.map((candidate) => {
        // A parameter segment is as close as it can be to whatever is in its place.
        const got = candidate.split("/");
        const filled = op.path
          .split("/")
          .map((segment, index) => (segment.includes("{") && got[index] ? got[index] : segment))
          .join("/");
        return levenshtein(candidate, filled);
      }),
    );
    return { label: `${op.method} ${op.path}`, distance };
  });
  return scored
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit)
    .map((entry) => entry.label);
}

// Choosing the response

/** A status the caller asked for, from `Prefer: code=`, `X-Mock-Status` or `?__status=`. */
export function requestedStatus(headers: Record<string, string>, query: URLSearchParams): number | null {
  const raw =
    /(?:^|[;,\s])code=(\d{3})\b/i.exec(headers.prefer ?? "")?.[1] ??
    headers[STATUS_HEADER]?.trim() ??
    query.get(STATUS_QUERY) ??
    null;
  if (!raw || !/^\d{3}$/.test(raw)) return null;
  const status = Number(raw);
  return status >= 100 && status <= 599 ? status : null;
}

/** A named example the caller asked for: `Prefer: example=paid`. */
export function requestedExample(headers: Record<string, string>): string | null {
  return /(?:^|[;,\s])example=([^;,\s]+)/i.exec(headers.prefer ?? "")?.[1] ?? null;
}

export interface ChosenResponse {
  status: number;
  /** The response object from the spec, `$ref` resolved; undefined when none fits. */
  definition: Json | undefined;
  /** Set when the status asked for isn't declared for this operation. */
  undeclared?: boolean;
}

const isSuccessKey = (key: string) => /^2(\d\d|XX)$/i.test(key);
const statusOfKey = (key: string) => (/^\d{3}$/.test(key) ? Number(key) : /^[1-5]XX$/i.test(key) ? Number(key[0]) * 100 : 200);

/**
 * Which declared response to send. A requested status is honoured when the spec
 * declares it (exactly, as `4XX`, or through `default`); one it doesn't declare
 * is still sent, with no body, and flagged. Otherwise the lowest 2xx the spec
 * declares (a parsed document keeps numeric keys in numeric order, not in the
 * order they were written), then `2XX`, then `default`, then the lowest status
 * declared.
 */
export function chooseResponse(doc: Json, responses: Json | undefined, requested: number | null): ChosenResponse {
  const entries = Object.entries<Json>(responses && typeof responses === "object" ? responses : {});
  const resolve = (def: Json) => deref(doc, def);
  if (requested !== null) {
    const exact = entries.find(([key]) => key === String(requested));
    if (exact) return { status: requested, definition: resolve(exact[1]) };
    const range = entries.find(([key]) => key.toUpperCase() === `${String(requested)[0]}XX`);
    if (range) return { status: requested, definition: resolve(range[1]) };
    const fallback = entries.find(([key]) => key === "default");
    if (fallback) return { status: requested, definition: resolve(fallback[1]) };
    return { status: requested, definition: undefined, undeclared: true };
  }
  const success = entries.find(([key]) => /^2\d\d$/.test(key)) ?? entries.find(([key]) => isSuccessKey(key));
  if (success) return { status: statusOfKey(success[0]), definition: resolve(success[1]) };
  const fallback = entries.find(([key]) => key === "default");
  if (fallback) return { status: 200, definition: resolve(fallback[1]) };
  if (entries.length) return { status: statusOfKey(entries[0][0]), definition: resolve(entries[0][1]) };
  return { status: 204, definition: undefined };
}

const baseType = (value: string) => value.split(";")[0].trim().toLowerCase();

/** Which of the declared media types to answer with, honouring `Accept` where it can. */
export function chooseMediaType(content: Json | undefined, accept: string | undefined): string | undefined {
  const types = Object.keys(content && typeof content === "object" ? content : {});
  if (!types.length) return undefined;
  const wanted = (accept ?? "")
    .split(",")
    .map(baseType)
    .filter((type) => type && type !== "*/*");
  for (const want of wanted) {
    const hit = types.find((type) => {
      const have = baseType(type);
      if (want.endsWith("/*")) return have.startsWith(want.slice(0, -1));
      return have === want;
    });
    if (hit) return hit;
  }
  return types.find((type) => type.toLowerCase().includes("json")) ?? types[0];
}

/** The body value for one media type, with a named example when one was asked for. */
export function responseValue(doc: Json, media: Json | undefined, exampleName: string | null): unknown {
  if (exampleName && media?.examples && typeof media.examples === "object" && !Array.isArray(media.examples)) {
    const named = media.examples[exampleName];
    const resolved = named ? deref(doc, named) : undefined;
    if (resolved && resolved.value !== undefined) return resolved.value;
  }
  return mediaExample(doc, media, "response");
}

function serialise(value: unknown, mediaType: string): string {
  if (value === undefined) return "";
  if (typeof value === "string" && !mediaType.toLowerCase().includes("json")) return value;
  if (!mediaType.toLowerCase().includes("json") && (typeof value === "number" || typeof value === "boolean")) {
    return String(value);
  }
  return JSON.stringify(value, null, 2);
}

/** Header values from the response's declared `headers`, generated the same way as bodies. */
function declaredHeaders(doc: Json, definition: Json | undefined): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [name, raw] of Object.entries<Json>(definition?.headers ?? {})) {
    if (name.toLowerCase() === "content-type" || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) continue;
    const header = deref(doc, raw);
    const value =
      header.example !== undefined
        ? header.example
        : responseValue(doc, header.examples ? { examples: header.examples } : undefined, null) ??
          exampleFor(doc, header.schema, name, "response");
    if (value === undefined || value === null) continue;
    out.push([name, headerSafe(typeof value === "object" ? JSON.stringify(value) : String(value))]);
  }
  return out;
}

/** Printable ASCII only, on one line: what a header value can hold. */
export function headerSafe(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ").replace(/[^\x20-\x7e]/g, "?");
}

// Checking the request

function checkScalar(doc: Json, param: ParamSpec, value: string): string | null {
  const schema = deref(doc, param.schema);
  const type = Array.isArray(schema.type) ? schema.type.find((t: string) => t !== "null") : schema.type;
  const label = `${param.in} parameter \`${param.name}\``;
  if (Array.isArray(schema.enum) && schema.enum.length && !schema.enum.map(String).includes(value)) {
    return `${label} is "${value}", not one of ${schema.enum.map(String).join(", ")}`;
  }
  if (type === "integer" && !/^-?\d+$/.test(value)) return `${label} should be an integer, got "${value}"`;
  if (type === "number" && (value.trim() === "" || !Number.isFinite(Number(value)))) {
    return `${label} should be a number, got "${value}"`;
  }
  if (type === "boolean" && value !== "true" && value !== "false") {
    return `${label} should be true or false, got "${value}"`;
  }
  if (schema.format === "uuid" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    return `${label} should be a UUID, got "${value}"`;
  }
  return null;
}

/** Headers OpenAPI says are described elsewhere and ignores as parameters. */
const IGNORED_HEADER_PARAMS = new Set(["accept", "content-type", "authorization"]);

/** Where the request differs from what the spec describes. Empty when it matches. */
export function checkRequest(
  spec: ParsedSpec,
  op: OperationSpec,
  params: Record<string, string>,
  request: MockRequest,
): string[] {
  const problems: string[] = [];
  const query = new URLSearchParams(request.query);
  for (const param of op.parameters) {
    let value: string | null = null;
    if (param.in === "path") value = params[param.name] ?? null;
    else if (param.in === "query") value = query.get(param.name);
    else if (param.in === "header") {
      if (IGNORED_HEADER_PARAMS.has(param.name.toLowerCase())) continue;
      value = request.headers[param.name.toLowerCase()] ?? null;
    } else continue;
    if (value === null) {
      if (param.required) problems.push(`missing required ${param.in} parameter \`${param.name}\``);
      continue;
    }
    const problem = checkScalar(spec.doc, param, value);
    if (problem) problems.push(problem);
  }

  const body = request.body;
  if (!op.requestBody) {
    if (body.trim()) problems.push("this operation takes no request body");
    return problems;
  }
  if (!body.trim()) {
    if (op.requestBody.required) problems.push("the request body is required");
    return problems;
  }
  const sent = request.headers["content-type"];
  if (!sent) {
    problems.push(`no Content-Type; the spec expects ${op.requestBody.contentType}`);
  } else if (baseType(sent) !== baseType(op.requestBody.contentType)) {
    const raw = spec.doc.paths?.[op.path]?.[op.method.toLowerCase()]?.requestBody;
    const declared = Object.keys(deref(spec.doc, raw)?.content ?? {}).map(baseType);
    if (!declared.includes(baseType(sent))) {
      problems.push(`Content-Type ${baseType(sent)} isn't one the spec accepts (${declared.join(", ")})`);
    }
  }
  if (op.requestBody.contentType.toLowerCase().includes("json") && (!sent || baseType(sent).includes("json"))) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      problems.push("the body isn't valid JSON");
      return problems;
    }
    const result = validateResponse(spec.doc, op.requestBody.schema, parsed);
    for (const finding of result.findings) {
      const where = finding.path.replace(/^\$\.?/, "") || "body";
      if (finding.kind === "missing_required") problems.push(`body: missing required field \`${where}\``);
      else if (finding.kind === "extra_field") problems.push(`body: \`${where}\` isn't in the spec`);
      else if (finding.kind === "type_mismatch") problems.push(`body: \`${where}\` ${finding.message.replace(/^Expected/, "should be")}`);
      else problems.push(`body: \`${where}\` ${finding.message}`);
    }
  }
  return problems;
}

/** Problems as one header value: short, ASCII, capped. */
export function warningsHeader(problems: string[]): string {
  let out = "";
  for (let index = 0; index < problems.length; index += 1) {
    const next = headerSafe(problems[index]);
    const joined = out ? `${out}; ${next}` : next;
    if (joined.length > MAX_WARNINGS_HEADER) return `${out}; and ${problems.length - index} more`;
    out = joined;
  }
  return out;
}

// The answer

function json(status: number, body: unknown, headers: Array<[string, string]> = []): MockResponse {
  return {
    status,
    headers: [["Content-Type", "application/json"], ...headers],
    body: JSON.stringify(body, null, 2),
  };
}

/** Answer one request from the spec. */
export function answerMockRequest(
  spec: ParsedSpec,
  request: MockRequest,
  options: MockOptions = DEFAULT_MOCK_OPTIONS,
): MockResponse {
  const method = request.method.toUpperCase();
  const match = matchOperation(spec, method, request.path);

  if (match.kind === "none") {
    return json(404, {
      error: `No operation in ${spec.title || "this spec"} matches ${method} ${request.path}.`,
      closest: match.closest,
      hint: "This is a local mock made from the spec. Check the path, or the base path in your client's URL.",
    });
  }
  if (match.kind === "method") {
    const allow = match.allowed.join(", ");
    // An OPTIONS that isn't a CORS preflight (Rust answers those) gets the methods.
    if (method === "OPTIONS") return { status: 204, headers: [["Allow", allow]], body: "" };
    return json(
      405,
      { error: `${request.path} doesn't take ${method}. The spec declares: ${allow}.`, allowed: match.allowed },
      [["Allow", allow]],
    );
  }

  const { op, params, head } = match;
  const query = new URLSearchParams(request.query);
  const operationHeader: [string, string] = [OPERATION_HEADER, headerSafe(`${op.method} ${op.path}`)];
  const problems = checkRequest(spec, op, params, request);

  if (problems.length && options.invalid === "reject") {
    return json(
      400,
      { error: `The request doesn't match the spec for ${op.method} ${op.path}.`, problems },
      [operationHeader],
    );
  }

  const raw = spec.doc.paths?.[op.path]?.[op.method.toLowerCase()] ?? {};
  const chosen = chooseResponse(spec.doc, raw.responses, requestedStatus(request.headers, query));
  if (chosen.undeclared) problems.push(`status ${chosen.status} isn't declared for this operation, so it has no body`);

  const headers: Array<[string, string]> = [operationHeader, ...declaredHeaders(spec.doc, chosen.definition)];
  let body = "";
  const noBody = head || chosen.status === 204 || chosen.status === 304 || chosen.status < 200;
  const mediaType = chooseMediaType(chosen.definition?.content, request.headers.accept);
  if (mediaType) {
    const value = responseValue(spec.doc, chosen.definition?.content?.[mediaType], requestedExample(request.headers));
    const text = serialise(value, mediaType);
    if (text && !noBody) body = text;
    if (text) headers.unshift(["Content-Type", headerSafe(mediaType)]);
  }
  if (problems.length) headers.push([WARNINGS_HEADER, warningsHeader(problems)]);
  return { status: chosen.status, headers, body };
}
