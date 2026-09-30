import { referenceFor, type PathSegment } from "./chain";
import {
  baseStepKey,
  newCollection,
  normaliseExpectedStatus,
  uniqueStepKey,
  DEFAULT_EXPECTED_STATUS,
  type Collection,
  type CollectionStep,
  type StepAuth,
  type StepTarget,
} from "./collection";
import { relinkStep } from "./collectionLink";
import type { Variable } from "./env";
import type { LibraryEntry } from "./library";
import type { BodyInput, MultipartPart } from "./request";
import type { OperationSpec, ParsedSpec, SecuritySchemeSpec } from "./spec";

/**
 * Bringing a Postman collection (v2.1, or v2.0) into Studio.
 *
 * The result is one Studio collection. Folders are flattened, in order, and a
 * folder's name becomes the start of each of its requests' names ("Orders /
 * Create order"). One collection rather than one per folder because a Postman
 * collection is usually one suite run top to bottom, and a value one folder
 * sets is often used in the next; splitting them would break that.
 *
 * Each request is matched to an operation in the library by method and path,
 * against each spec's servers. A match becomes a linked step, with everything
 * a linked step gets; anything else is kept as a plain request, marked as not
 * in any spec, so nothing is lost.
 *
 * Secrets never go into the collection. An auth value or credential header
 * typed into Postman becomes a `{{variable}}`, and its value is offered to a new
 * environment as a secret variable, which the user can decline.
 *
 * Scripts are not run. A test that checks a status sets the step's expected
 * status, and `pm.environment.set("x", pm.response.json().id)` becomes a
 * reference in the later steps that use `{{x}}`, when that is unambiguous.
 * Everything else a script did is listed in the step's note.
 *
 * Pure: no React, no IO.
 */

// ── Postman's shapes, as loosely as they are written ──────────────────────────

interface PmKeyValue {
  key?: string;
  id?: string;
  value?: unknown;
  disabled?: boolean;
  type?: string;
  src?: string | string[] | null;
  contentType?: string;
}

interface PmUrl {
  raw?: string;
  protocol?: string;
  host?: string | string[];
  port?: string;
  path?: string | string[];
  query?: PmKeyValue[];
  variable?: PmKeyValue[];
}

interface PmAuth {
  type?: string;
  [params: string]: unknown;
}

interface PmBody {
  mode?: string;
  raw?: string;
  urlencoded?: PmKeyValue[];
  formdata?: PmKeyValue[];
  file?: { src?: string | null };
  graphql?: { query?: string; variables?: string };
  options?: { raw?: { language?: string } };
  disabled?: boolean;
}

interface PmRequest {
  method?: string;
  url?: string | PmUrl;
  header?: PmKeyValue[] | string;
  body?: PmBody;
  auth?: PmAuth | null;
}

interface PmEvent {
  listen?: string;
  script?: { exec?: string | string[] };
}

interface PmItem {
  name?: string;
  item?: PmItem[];
  request?: PmRequest | string;
  event?: PmEvent[];
  auth?: PmAuth | null;
}

// ── the result ────────────────────────────────────────────────────────────────

/** The library an import is matched against: entries, and their specs as read. */
export interface ImportLibrary {
  entries: readonly LibraryEntry[];
  specs: ReadonlyMap<string, ParsedSpec | null>;
}

export interface ImportSummary {
  name: string;
  /** Requests found in the collection, in every folder. */
  requests: number;
  /** Linked steps, per API in the library. */
  linked: Array<{ api: string; count: number }>;
  /** Requests kept as plain requests, with why. */
  notInSpec: Array<{ key: string; label: string; reason: string }>;
  /** How many steps had a Postman script. */
  scripts: number;
  /** Status checks turned into an expected status. */
  statuses: Array<{ key: string; status: string }>;
  /** Variables a script set that later steps now take from a response. */
  chained: Array<{ variable: string; reference: string }>;
  /** Variables a script set that stay `{{variables}}`, with why. */
  unchained: Array<{ variable: string; reason: string }>;
  /** What else the user should know: things left out, dynamic variables. */
  warnings: string[];
}

export interface EnvironmentDraft {
  name: string;
  variables: Variable[];
}

export interface PostmanImport {
  collection: Collection;
  /** The collection's variables and any credentials taken out of it; null when there are none. */
  environment: EnvironmentDraft | null;
  summary: ImportSummary;
}

// ── small helpers ─────────────────────────────────────────────────────────────

const str = (value: unknown): string => (value === undefined || value === null ? "" : String(value));
const keyOf = (kv: PmKeyValue) => str(kv.key ?? kv.id);
const enabled = (list: unknown): PmKeyValue[] =>
  Array.isArray(list) ? (list as PmKeyValue[]).filter((kv) => kv && !kv.disabled && keyOf(kv) !== "") : [];

const VAR = /\{\{\s*([^{}\s]+)\s*\}\}/g;
const hasVariable = (text: string) => /\{\{\s*[^{}\s]+\s*\}\}/.test(text);

/** Substitute the collection's variables, a few levels deep (`{{baseUrl}}` = `{{host}}/v1`). */
function resolve(text: string, vars: Record<string, string>): string {
  let out = text;
  for (let depth = 0; depth < 4 && out.includes("{{"); depth += 1) {
    const next = out.replace(VAR, (whole, name: string) =>
      Object.prototype.hasOwnProperty.call(vars, name) && vars[name] !== "" ? vars[name] : whole,
    );
    if (next === out) break;
    out = next;
  }
  return out;
}

/** A camelCase key from a request's name: "Create order" → `createOrder`. */
function keyFromName(name: string): string {
  const words = name
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, " ")
    .split(/[\s_-]+/)
    .filter(Boolean);
  const joined = words
    // "GET" and "ORDERS" read as words; "basicAuth" keeps its own capitals.
    .map((word) => (word === word.toUpperCase() ? word.toLowerCase() : word))
    .map((word, i) => (i === 0 ? word[0].toLowerCase() : word[0].toUpperCase()) + word.slice(1))
    .join("")
    .replace(/[^A-Za-z0-9_]/g, "");
  return /^[A-Za-z_]/.test(joined) ? joined : joined ? `step${joined}` : "";
}

/** A variable name from a hint: "X-Api-Key" → `xApiKey`. */
function variableName(hint: string): string {
  return keyFromName(hint) || "secret";
}

const SECRET_NAME = /(token|secret|password|passwd|pwd|api[-_]?key|apikey|auth|credential|private|session|cookie|signature|jwt|bearer)/i;

/** Whether a variable's name says it holds a secret. */
export function looksSecret(name: string): boolean {
  return SECRET_NAME.test(name);
}

/** Postman's script lines, as one text. */
function scriptText(event: PmEvent): string {
  const exec = event.script?.exec;
  return Array.isArray(exec) ? exec.join("\n") : str(exec);
}

function scriptsOf(events: PmEvent[] | undefined): { prerequest: string; test: string } {
  const pick = (listen: string) =>
    (events ?? [])
      .filter((e) => e?.listen === listen)
      .map(scriptText)
      .filter((text) => text.trim())
      .join("\n");
  return { prerequest: pick("prerequest"), test: pick("test") };
}

// ── what a test script says ───────────────────────────────────────────────────

/** Where a script took a variable's value from, when it's something a reference can say. */
type ValueSource = { kind: "body"; path: PathSegment[] } | { kind: "header"; name: string };

export interface ScriptFacts {
  /** The status the script checks for, when it checks exactly one (or one class). */
  status?: string;
  /** It checks more than one status, so none was taken. */
  statusAmbiguous?: boolean;
  /** Variables it sets, with where the value comes from when Studio can say. */
  sets: Array<{ variable: string; source: ValueSource | null }>;
}

const NAMED_STATUS: Record<string, string> = {
  ok: "2XX",
  success: "2XX",
  accepted: "202",
  withBody: "",
  info: "1XX",
  redirection: "3XX",
  clientError: "4XX",
  serverError: "5XX",
  error: "",
  badRequest: "400",
  unauthorized: "401",
  unauthorised: "401",
  forbidden: "403",
  notFound: "404",
  rateLimited: "429",
};

/** `.data.items[0]["order-id"]` → `["data", "items", 0, "order-id"]`; null when it isn't a plain path. */
function accessPath(text: string): PathSegment[] | null {
  const out: PathSegment[] = [];
  const pattern = /\.([A-Za-z_$][\w$-]*)|\[\s*(\d+)\s*\]|\[\s*(['"])([^'"]+)\3\s*\]/y;
  let at = 0;
  while (at < text.length) {
    pattern.lastIndex = at;
    const match = pattern.exec(text);
    if (!match) return null;
    if (match[1] !== undefined) out.push(match[1]);
    else if (match[2] !== undefined) out.push(Number(match[2]));
    else {
      // A key a reference can't spell (a dot or a space in it).
      if (/[\s.{}[\]]/.test(match[4])) return null;
      out.push(match[4]);
    }
    at = pattern.lastIndex;
  }
  return out;
}

/** What a Postman test script checks and sets, as far as simple patterns go. */
export function readTestScript(script: string): ScriptFacts {
  const statuses = new Set<string>();
  const add = (value: string) => {
    const status = normaliseExpectedStatus(value);
    if (status) statuses.add(status);
  };
  for (const m of script.matchAll(/pm\.response\.to\.(?:have|be)\.status\(\s*(\d{3})\s*\)/g)) add(m[1]);
  for (const m of script.matchAll(
    /pm\.expect\(\s*pm\.response\.(?:code|status)\s*\)\.to(?:\.be|\.deep)?\.(?:eql|equal|equals|eq)\(\s*(\d{3})\s*\)/g,
  )) {
    add(m[1]);
  }
  for (const m of script.matchAll(/(?:pm\.response\.code|responseCode\.code)\s*={2,3}\s*(\d{3})/g)) add(m[1]);
  for (const m of script.matchAll(/pm\.expect\(\s*pm\.response\.code\s*\)\.to\.be\.oneOf\(\s*\[([^\]]*)\]\s*\)/g)) {
    const codes = m[1].split(",").map((c) => c.trim()).filter((c) => /^\d{3}$/.test(c));
    const classes = new Set(codes.map((c) => c[0]));
    if (classes.size === 1) add(`${[...classes][0]}XX`);
    else codes.forEach(add);
  }
  for (const m of script.matchAll(/pm\.response\.to\.(?:be|not\.be)\.(\w+)\b(?!\()/g)) {
    if (m[0].includes(".not.")) continue;
    const status = NAMED_STATUS[m[1]];
    if (status) add(status);
  }

  // `const json = pm.response.json();` and the older `JSON.parse(responseBody)`.
  const aliases = new Set<string>();
  for (const m of script.matchAll(
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:pm\.response\.json\(\s*\)|JSON\.parse\(\s*responseBody\s*\))\s*;?/g,
  )) {
    aliases.add(m[1]);
  }
  const sets: ScriptFacts["sets"] = [];
  const setter =
    /(?:pm\.(?:environment|collectionVariables|globals|variables)\.set|postman\.set(?:Environment|Global)Variable)\(\s*(['"`])([^'"`]+)\1\s*,\s*([^;\n]*?)\s*\)\s*;?\s*$/gm;
  for (const m of script.matchAll(setter)) {
    const variable = m[2];
    const expr = m[3].trim();
    let source: ValueSource | null = null;
    const header = /^pm\.response\.headers\.get\(\s*(['"])([^'"]+)\1\s*\)$/.exec(expr);
    if (header) source = { kind: "header", name: header[2] };
    else {
      const body = /^(?:pm\.response\.json\(\s*\)|JSON\.parse\(\s*responseBody\s*\)|([A-Za-z_$][\w$]*))(.*)$/.exec(expr);
      if (body && (!body[1] || aliases.has(body[1]))) {
        const path = accessPath(body[2]);
        if (path) source = { kind: "body", path };
      }
    }
    sets.push({ variable, source });
  }
  if (statuses.size > 1) return { statusAmbiguous: true, sets };
  const status = [...statuses][0];
  return { ...(status ? { status } : {}), sets };
}

// ── URLs ──────────────────────────────────────────────────────────────────────

interface RequestUrl {
  /** Scheme, host and path, as written in Postman: `{{baseUrl}}/orders/:orderId`. */
  base: string;
  query: Array<{ key: string; value: string }>;
  /** Values for `:name` path variables. */
  pathVars: Record<string, string>;
}

function urlOf(url: string | PmUrl | undefined): RequestUrl {
  if (!url) return { base: "", query: [], pathVars: {} };
  const splitRaw = (raw: string) => {
    const noHash = raw.split("#")[0];
    const at = noHash.indexOf("?");
    return at < 0 ? { base: noHash, search: "" } : { base: noHash.slice(0, at), search: noHash.slice(at + 1) };
  };
  const fromSearch = (search: string) =>
    search
      .split("&")
      .filter(Boolean)
      .map((pair) => {
        const at = pair.indexOf("=");
        return at < 0 ? { key: pair, value: "" } : { key: pair.slice(0, at), value: pair.slice(at + 1) };
      });
  if (typeof url === "string") {
    const { base, search } = splitRaw(url);
    return { base: base.trim(), query: fromSearch(search), pathVars: {} };
  }
  let base: string;
  let search = "";
  if (url.raw) ({ base, search } = splitRaw(url.raw));
  else {
    const host = Array.isArray(url.host) ? url.host.join(".") : str(url.host);
    const path = Array.isArray(url.path) ? url.path.join("/") : str(url.path).replace(/^\//, "");
    base = `${url.protocol ? `${url.protocol}://` : ""}${host}${url.port ? `:${url.port}` : ""}${path ? `/${path}` : ""}`;
  }
  const query = Array.isArray(url.query)
    ? enabled(url.query).map((kv) => ({ key: keyOf(kv), value: str(kv.value) }))
    : fromSearch(search);
  const pathVars = Object.fromEntries(enabled(url.variable).map((kv) => [keyOf(kv), str(kv.value)]));
  return { base: base.trim(), query, pathVars };
}

/** A URL Studio can send: Postman lets `api.example.com/orders` go without a scheme. */
function withScheme(url: string): string {
  return !url || /^[a-z][a-z0-9+.-]*:\/\//i.test(url) || url.startsWith("{{") ? url : `https://${url}`;
}

/** `:orderId` segments filled with their values, or `{{orderId}}` when Postman had none. */
function fillPathVars(base: string, pathVars: Record<string, string>): string {
  return base.replace(/(^|\/):([A-Za-z_][\w-]*)(?=\/|$)/g, (_whole, slash: string, name: string) => {
    const value = pathVars[name];
    return `${slash}${value !== undefined && value !== "" ? value : `{{${name}}}`}`;
  });
}

interface Located {
  /** `https://api.example.com`, lower-cased; null when the host is an unresolved variable or missing. */
  origin: string | null;
  /** The leading `{{variable}}` the URL starts with, when it couldn't be resolved. */
  hostVariable: string | null;
  /** Path segments after the origin, resolved as far as the collection's variables go. */
  segments: string[];
  /** The same segments as written, for reading path values from. */
  written: string[];
  local: boolean;
}

const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443" };

function originOf(text: string): { origin: string; host: string } | null {
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const port = url.port && url.port !== DEFAULT_PORTS[url.protocol] ? `:${url.port}` : "";
    return { origin: `${url.protocol}//${url.hostname.toLowerCase()}${port}`, host: url.hostname.toLowerCase() };
  } catch {
    return null;
  }
}

const splitPath = (path: string) => path.split("/").filter((s) => s !== "");

/** Where a request goes, as far as the collection's own variables can say. */
function locate(base: string, vars: Record<string, string>): Located {
  // Only a leading variable is resolved into the origin; variables later in the
  // path are values (`/orders/{{orderId}}`) and stay as they are.
  const leading = /^\{\{\s*([^{}\s]+)\s*\}\}/.exec(base);
  let head = "";
  let tail = base;
  if (leading) {
    head = resolve(leading[0], vars);
    tail = base.slice(leading[0].length);
  }
  const full = head + tail;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(full)
    ? full
    : /^[\w.-]+(:\d+)?(\/|$)/.test(full) && !full.startsWith("{{")
      ? `https://${full}`
      : null;
  if (withScheme) {
    const at = withScheme.indexOf("/", withScheme.indexOf("://") + 3);
    const originText = at < 0 ? withScheme : withScheme.slice(0, at);
    const found = originOf(originText);
    const pathText = at < 0 ? "" : withScheme.slice(at);
    const written = splitPath(pathText);
    const segments = written.map((s) => resolve(s, vars));
    const local = found ? /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|.*\.local|.*\.localhost)$/.test(found.host) : false;
    return { origin: found?.origin ?? null, hostVariable: null, segments, written, local };
  }
  // Still starts with a variable nobody gave a value: the host is unknown.
  const unresolved = /^\{\{\s*([^{}\s]+)\s*\}\}(.*)$/.exec(full);
  const rest = unresolved ? unresolved[2] : full;
  const written = splitPath(rest);
  return {
    origin: null,
    hostVariable: unresolved ? unresolved[1] : null,
    segments: written.map((s) => resolve(s, vars)),
    written,
    local: false,
  };
}

// ── finding the operation ─────────────────────────────────────────────────────

interface Match {
  entry: LibraryEntry;
  spec: ParsedSpec;
  op: OperationSpec;
  /** The declared server the URL is on, when its host matched one. */
  server: string | null;
  /** How many of the path's segments are literal: `/orders/search` beats `/orders/{id}`. */
  literal: number;
  pathParams: Record<string, string>;
  /** Segments before the operation's path (a base path like `/v1`). */
  prefix: number;
}

function serverParts(server: string): { origin: RegExp | null; path: string[] } {
  const templated = (text: string) =>
    new RegExp(
      `^${text
        .toLowerCase()
        .split(/\{[^}]+\}/)
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]+")}$`,
    );
  const scheme = /^([a-z][a-z0-9+.-]*:\/\/)([^/]*)(.*)$/i.exec(server);
  if (!scheme) return { origin: null, path: splitPath(server) };
  const origin = `${scheme[1]}${scheme[2]}`.replace(/:(80|443)$/, (whole, port: string) =>
    (port === "443" && /^https/i.test(scheme[1])) || (port === "80" && /^http:/i.test(scheme[1])) ? "" : whole,
  );
  return { origin: templated(origin), path: splitPath(scheme[3]) };
}

function sameSegments(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((seg, i) => /^\{.+\}$/.test(b[i]) || seg === b[i]);
}

/** Every operation this request could be, strongest first. */
function candidates(method: string, where: Located, library: ImportLibrary, pathVars: Record<string, string>): Match[] {
  const out: Match[] = [];
  for (const entry of library.entries) {
    const spec = library.specs.get(entry.id);
    if (!spec) continue;
    const servers = spec.servers.map((url) => ({ url, ...serverParts(url) }));
    for (const op of spec.operations) {
      if (op.method.toUpperCase() !== method) continue;
      const template = splitPath(op.path);
      const offset = where.segments.length - template.length;
      if (offset < 0) continue;
      const pathParams: Record<string, string> = {};
      let literal = 0;
      let ok = true;
      for (let i = 0; i < template.length && ok; i += 1) {
        const seg = template[i];
        const got = where.segments[offset + i];
        const written = where.written[offset + i] ?? got;
        const placeholder = /^\{(.+)\}$/.exec(seg);
        if (placeholder) {
          const pathVar = /^:([A-Za-z_][\w-]*)$/.exec(written);
          let value = pathVar ? (pathVars[pathVar[1]] || `{{${pathVar[1]}}}`) : written;
          if (!hasVariable(value)) {
            try {
              value = decodeURIComponent(value);
            } catch {
              // Leave it as written.
            }
          }
          pathParams[placeholder[1]] = value;
        } else if (seg === got) literal += 1;
        else ok = false;
      }
      if (!ok) continue;
      const prefix = where.segments.slice(0, offset);
      // The URL's host and base path are one of the spec's servers.
      const onServer = where.origin
        ? servers.find((s) => s.origin?.test(where.origin!) && sameSegments(prefix, s.path))
        : undefined;
      if (onServer) {
        out.push({ entry, spec, op, server: onServer.url, literal: literal + 1000, pathParams, prefix: offset });
        continue;
      }
      // The host is a variable with no value, or a server on this computer: the
      // path alone decides, and the base path must still be one the spec uses.
      if (where.origin === null || where.local) {
        const basePathOk = prefix.length === 0 || servers.some((s) => sameSegments(prefix, s.path));
        if (basePathOk) out.push({ entry, spec, op, server: null, literal, pathParams, prefix: offset });
      }
    }
  }
  return out.sort((a, b) => b.literal - a.literal);
}

type Decision = { kind: "linked"; match: Match } | { kind: "unlinked"; reason: string };

function decide(method: string, where: Located, library: ImportLibrary, pathVars: Record<string, string>, pathText: string): Decision {
  if (!library.entries.length) return { kind: "unlinked", reason: "Your library has no APIs yet." };
  const found = candidates(method, where, library, pathVars);
  if (!found.length) {
    return {
      kind: "unlinked",
      reason: where.origin && !where.local
        ? `No API in your library has ${method} ${pathText} on this server.`
        : `No API in your library has ${method} ${pathText}.`,
    };
  }
  const best = found.filter((m) => m.literal === found[0].literal);
  // The same API in the library twice (two versions of one spec, say) isn't a
  // real choice: take the one added or opened most recently.
  const recency = (m: Match) => [m.entry.openedAt, m.entry.addedAt].sort().pop() ?? "";
  const byApi = new Map<string, Match>();
  for (const m of best) {
    const key = `${m.entry.title} ${m.op.method} ${m.op.path}`;
    const seen = byApi.get(key);
    if (!seen || recency(m) > recency(seen)) byApi.set(key, m);
  }
  const distinct = new Map([...byApi.values()].map((m) => [`${m.entry.id} ${m.op.id}`, m]));
  if (distinct.size === 1) return { kind: "linked", match: [...distinct.values()][0] };
  const apis = [...new Set([...distinct.values()].map((m) => m.entry.title))];
  return {
    kind: "unlinked",
    reason:
      apis.length > 1
        ? `${method} ${pathText} is in more than one API (${apis.join(", ")}). Link it to the right one.`
        : `${method} ${pathText} matches more than one operation in ${apis[0]}. Link it to the right one.`,
  };
}

// ── auth and secrets ──────────────────────────────────────────────────────────

/** Postman auth parameters as a map; v2.1 writes a list, v2.0 an object. */
function authParams(auth: PmAuth, type: string): Record<string, string> {
  const raw = auth[type];
  if (Array.isArray(raw)) return Object.fromEntries((raw as PmKeyValue[]).map((kv) => [keyOf(kv), str(kv.value)]));
  if (raw && typeof raw === "object") {
    return Object.fromEntries(Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k, str(v)]));
  }
  return {};
}

/** Takes literal credentials out of the collection, into (offered) secret variables. */
class Secrets {
  readonly values = new Map<string, string>();
  constructor(private readonly taken: Set<string>) {}

  /** `{{name}}` for a literal value, reusing a name when the same value was seen before. */
  refer(hint: string, value: string): string {
    for (const [name, existing] of this.values) if (existing === value) return `{{${name}}}`;
    const base = variableName(hint);
    let name = base;
    for (let n = 2; this.taken.has(name); n += 1) name = `${base}${n}`;
    this.taken.add(name);
    this.values.set(name, value);
    return `{{${name}}}`;
  }

  /** The value as it may be written: itself when it is (or contains) a variable, a reference otherwise. */
  keep(hint: string, value: string): string {
    if (!value || hasVariable(value)) return value;
    return this.refer(hint, value);
  }
}

const CREDENTIAL_HEADERS = /^(authorization|proxy-authorization|cookie|x-api-key|api-key|apikey|x-auth-token|x-access-token)$/i;

/** A header value with a literal credential swapped for a variable. */
function headerValue(name: string, value: string, secrets: Secrets): string {
  if (!value || hasVariable(value) || !(CREDENTIAL_HEADERS.test(name) || looksSecret(name))) return value;
  const scheme = /^(Bearer|Token|Basic|ApiKey|Digest)\s+(.+)$/i.exec(value);
  if (scheme) {
    const hint = scheme[1].toLowerCase() === "basic" ? "basicAuth" : "token";
    return `${scheme[1]} ${secrets.refer(hint, scheme[2])}`;
  }
  return secrets.refer(/^authorization$/i.test(name) ? "token" : name, value);
}

/** Literal values of secret-looking fields in a JSON body (`"password": "…"`), as variables. */
function bodyValue(body: string, secrets: Secrets): string {
  return body.replace(
    /("((?:[\w-]*)(?:password|passwd|secret|token|api[_-]?key|apikey)(?:[\w-]*))"\s*:\s*")([^"{}\\]+)(")/gi,
    (_whole, before: string, field: string, value: string, after: string) => `${before}${secrets.refer(field, value)}${after}`,
  );
}

interface AuthOutcome {
  auth?: StepAuth;
  headers: Record<string, string>;
  query: Array<{ key: string; value: string }>;
  notes: string[];
}

/** Postman auth as Studio will send it: a spec's scheme when there is one, a header otherwise. */
function mapAuth(auth: PmAuth | null | undefined, spec: ParsedSpec | null, secrets: Secrets): AuthOutcome {
  const out: AuthOutcome = { headers: {}, query: [], notes: [] };
  const type = str(auth?.type);
  if (!auth || !type || type === "noauth") return out;
  const params = authParams(auth, type);
  const schemes: SecuritySchemeSpec[] = spec?.securitySchemes ?? [];
  const asAuth = (scheme: SecuritySchemeSpec, value: string): StepAuth => ({
    scheme: scheme.name,
    type: scheme.type,
    ...(scheme.scheme ? { httpScheme: scheme.scheme } : {}),
    ...(scheme.in ? { in: scheme.in } : {}),
    ...(scheme.paramName ? { paramName: scheme.paramName } : {}),
    value,
  });
  if (type === "bearer") {
    const value = secrets.keep("token", params.token ?? "");
    const scheme =
      schemes.find((s) => s.type === "http" && s.scheme?.toLowerCase() === "bearer") ??
      schemes.find((s) => s.type === "oauth2" || s.type === "openIdConnect");
    if (scheme && scheme.type === "http") out.auth = asAuth(scheme, value);
    else out.headers.Authorization = `Bearer ${value}`;
    return out;
  }
  if (type === "basic") {
    const username = params.username ?? "";
    const password = params.password ?? "";
    const scheme = schemes.find((s) => s.type === "http" && s.scheme?.toLowerCase() === "basic");
    if (scheme) {
      out.auth = asAuth(scheme, `${username}:${secrets.keep("password", password)}`);
      return out;
    }
    if (!hasVariable(username) && !hasVariable(password)) {
      // No basic scheme to encode it when sending: keep the encoded pair as one secret.
      let encoded: string | null = null;
      try {
        encoded = btoa(`${username}:${password}`);
      } catch {
        encoded = null;
      }
      if (encoded) {
        out.headers.Authorization = `Basic ${secrets.refer("basicAuth", encoded)}`;
        return out;
      }
    }
    out.notes.push(
      "Postman sent basic auth built from variables. Studio sends basic auth through a spec's security scheme: link this step to an operation that declares one, or add an Authorization header.",
    );
    return out;
  }
  if (type === "apikey") {
    const name = params.key || "X-API-Key";
    const where = (params.in || "header").toLowerCase();
    const value = secrets.keep(name, params.value ?? "");
    const scheme = schemes.find(
      (s) => s.type === "apiKey" && (s.in ?? "header") === where && (s.paramName ?? "").toLowerCase() === name.toLowerCase(),
    );
    if (scheme) out.auth = asAuth(scheme, value);
    else if (where === "query") out.query.push({ key: name, value });
    else out.headers[name] = value;
    return out;
  }
  out.notes.push(`Postman used ${type} auth, which wasn't brought across. Set up auth for this step in Studio.`);
  return out;
}

// ── bodies ────────────────────────────────────────────────────────────────────

/** `a=1&b={{x}}`, encoding everything but variables, for a request with no operation to encode it. */
function encodeForm(fields: Array<{ key: string; value: string }>): string {
  const encode = (text: string) =>
    text
      .split(/(\{\{[^{}]+\}\})/)
      .map((part) => (/^\{\{[^{}]+\}\}$/.test(part) ? part : encodeURIComponent(part)))
      .join("");
  return fields.map((f) => `${encode(f.key)}=${encode(f.value)}`).join("&");
}

interface BodyOutcome {
  body?: BodyInput;
  contentType?: string;
  notes: string[];
}

function mapBody(body: PmBody | undefined, linked: boolean, secrets: Secrets): BodyOutcome {
  const notes: string[] = [];
  if (!body || body.disabled || !body.mode) return { notes };
  switch (body.mode) {
    case "raw": {
      const text = bodyValue(str(body.raw), secrets);
      if (!text.trim()) return { notes };
      const language = body.options?.raw?.language;
      const contentType =
        language === "json" ? "application/json" : language === "xml" ? "application/xml" : language === "text" ? "text/plain" : undefined;
      return { body: text, ...(contentType ? { contentType } : {}), notes };
    }
    case "urlencoded": {
      const fields = enabled(body.urlencoded).map((kv) => ({
        key: keyOf(kv),
        value: looksSecret(keyOf(kv)) ? secrets.keep(keyOf(kv), str(kv.value)) : str(kv.value),
      }));
      if (!fields.length) return { notes };
      if (linked) return { body: { kind: "form", fields }, notes };
      return { body: encodeForm(fields), contentType: "application/x-www-form-urlencoded", notes };
    }
    case "formdata": {
      const parts: MultipartPart[] = [];
      const files: string[] = [];
      for (const kv of enabled(body.formdata)) {
        const name = keyOf(kv);
        if (kv.type === "file") {
          const src = Array.isArray(kv.src) ? kv.src[0] : kv.src;
          if (src) {
            parts.push({ name, path: src, fileName: src.split(/[\\/]/).pop(), ...(kv.contentType ? { contentType: kv.contentType } : {}) });
            files.push(src);
          } else {
            parts.push({ name, value: "" });
            notes.push(`The file for the form field "${name}" wasn't chosen in Postman. Pick one before running this step.`);
          }
        } else {
          parts.push({
            name,
            value: looksSecret(name) ? secrets.keep(name, str(kv.value)) : str(kv.value),
            ...(kv.contentType ? { contentType: kv.contentType } : {}),
          });
        }
      }
      if (!parts.length) return { notes };
      if (files.length) {
        notes.push(
          `The form's file ${files.length === 1 ? "part points" : "parts point"} at ${files.join(", ")}, a path on the computer the collection was made on. Check ${files.length === 1 ? "it exists" : "they exist"} here.`,
        );
      }
      if (!linked) notes.push("Studio sends a multipart form only for a step linked to an operation. Link this step to send it.");
      return { body: { kind: "multipart", parts }, notes };
    }
    case "graphql": {
      const query = str(body.graphql?.query);
      let variables: unknown = {};
      try {
        variables = body.graphql?.variables ? JSON.parse(body.graphql.variables) : {};
      } catch {
        notes.push("The GraphQL variables weren't valid JSON, so they were left out.");
      }
      return { body: JSON.stringify({ query, variables }, null, 2), contentType: "application/json", notes };
    }
    case "file":
      notes.push(
        `Postman sent a file as the whole body${body.file?.src ? ` (${body.file.src})` : ""}. Studio can't send that from a collection yet, so the body was left out.`,
      );
      return { notes };
    default:
      notes.push(`The body (${body.mode}) wasn't brought across.`);
      return { notes };
  }
}

// ── headers ───────────────────────────────────────────────────────────────────

/** Headers Studio sets itself for a linked step, from the spec. */
const MANAGED = new Set(["content-type", "accept", "content-length", "host", "user-agent", "accept-encoding", "connection"]);

function headersOf(header: PmRequest["header"]): Array<{ key: string; value: string }> {
  if (typeof header === "string") {
    return header
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("//"))
      .map((line) => {
        const at = line.indexOf(":");
        return at < 0 ? { key: line, value: "" } : { key: line.slice(0, at).trim(), value: line.slice(at + 1).trim() };
      });
  }
  return enabled(header).map((kv) => ({ key: keyOf(kv), value: str(kv.value) }));
}

// ── flattening ────────────────────────────────────────────────────────────────

interface FlatRequest {
  name: string;
  request: PmRequest;
  auth: PmAuth | null | undefined;
  events: PmEvent[] | undefined;
}

function flatten(
  items: PmItem[] | undefined,
  folders: string[],
  inheritedAuth: PmAuth | null | undefined,
  out: FlatRequest[],
  folderScripts: string[],
): void {
  for (const item of items ?? []) {
    if (!item || typeof item !== "object") continue;
    const name = str(item.name).trim();
    // An item with `auth: null` inherits; `{ type: "noauth" }` stops inheriting.
    const auth = item.auth === undefined || item.auth === null ? inheritedAuth : item.auth;
    if (Array.isArray(item.item)) {
      const scripts = scriptsOf(item.event);
      if (scripts.prerequest || scripts.test) folderScripts.push(name || "(unnamed folder)");
      flatten(item.item, name ? [...folders, name] : folders, auth, out, folderScripts);
      continue;
    }
    if (item.request === undefined) continue;
    const request: PmRequest = typeof item.request === "string" ? { method: "GET", url: item.request } : item.request;
    const requestAuth = request.auth === undefined || request.auth === null ? auth : request.auth;
    out.push({
      name: [...folders, name || `${str(request.method || "GET").toUpperCase()} request`].join(" / "),
      request,
      auth: requestAuth,
      events: item.event,
    });
  }
}

// ── chaining ──────────────────────────────────────────────────────────────────

/** Every string a step sends, rewritten. */
function rewriteStep(step: CollectionStep, rewrite: (text: string) => string): CollectionStep {
  const map = (values: Record<string, string>) => Object.fromEntries(Object.entries(values).map(([k, v]) => [k, rewrite(v)]));
  let body = step.body;
  if (typeof body === "string") body = rewrite(body);
  else if (body?.kind === "form") body = { ...body, fields: body.fields.map((f) => ({ ...f, value: rewrite(f.value) })) };
  else if (body?.kind === "multipart") {
    body = { ...body, parts: body.parts.map((p) => (p.value === undefined ? p : { ...p, value: rewrite(p.value) })) };
  }
  return {
    ...step,
    ...(step.request ? { request: { ...step.request, url: rewrite(step.request.url) } } : {}),
    ...(step.target?.kind === "custom" ? { target: { kind: "custom", url: rewrite(step.target.url) } } : {}),
    pathParams: map(step.pathParams),
    queryParams: map(step.queryParams),
    headers: map(step.headers),
    ...(body !== undefined ? { body } : {}),
    ...(step.auth ? { auth: { ...step.auth, value: rewrite(step.auth.value) } } : {}),
  };
}

function usesVariable(step: CollectionStep, name: string): boolean {
  let used = false;
  const pattern = new RegExp(`\\{\\{\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\}\\}`);
  rewriteStep(step, (text) => {
    if (pattern.test(text)) used = true;
    return text;
  });
  return used;
}

// ── the import ────────────────────────────────────────────────────────────────

/**
 * Turn a Postman collection into a Studio collection, matched against the
 * library. `data` is the parsed JSON (see `detectImportFormat`).
 */
export function importPostman(data: Record<string, unknown>, library: ImportLibrary): PostmanImport {
  const info = (data.info ?? {}) as Record<string, unknown>;
  const name = str(info.name).trim() || "Imported collection";
  const collectionVars = enabled(data.variable).map((kv) => ({
    name: keyOf(kv),
    value: str(kv.value),
    secret: kv.type === "secret" || looksSecret(keyOf(kv)),
  }));
  const vars = Object.fromEntries(collectionVars.map((v) => [v.name, v.value]));
  const secrets = new Secrets(new Set(collectionVars.map((v) => v.name)));
  const warnings: string[] = [];

  const flat: FlatRequest[] = [];
  const folderScripts: string[] = [];
  flatten(data.item as PmItem[] | undefined, [], data.auth as PmAuth | null | undefined, flat, folderScripts);
  const collectionScripts = scriptsOf(data.event as PmEvent[] | undefined);

  let collection: Collection = newCollection(name);
  if (typeof info.description === "string" && info.description.trim()) {
    collection = { ...collection, description: info.description.trim() };
  }
  const summary: ImportSummary = {
    name,
    requests: flat.length,
    linked: [],
    notInSpec: [],
    scripts: 0,
    statuses: [],
    chained: [],
    unchained: [],
    warnings,
  };
  const setters: Array<{ index: number; variable: string; source: ValueSource | null }> = [];

  for (const item of flat) {
    const method = str(item.request.method || "GET").toUpperCase();
    const url = urlOf(item.request.url);
    const where = locate(url.base, vars);
    const pathText = `/${where.written.join("/")}`;
    const decision = decide(method, where, library, url.pathVars, pathText);
    const match = decision.kind === "linked" ? decision.match : null;
    const notes: string[] = [];

    const auth = mapAuth(item.auth, match?.spec ?? null, secrets);
    notes.push(...auth.notes);
    const body = mapBody(item.request.body, Boolean(match), secrets);
    notes.push(...body.notes);

    const headers: Record<string, string> = {};
    for (const { key, value } of headersOf(item.request.header)) {
      if (match && MANAGED.has(key.toLowerCase())) continue;
      headers[key] = headerValue(key, value, secrets);
    }
    for (const [key, value] of Object.entries(auth.headers)) {
      if (!Object.keys(headers).some((h) => h.toLowerCase() === key.toLowerCase())) headers[key] = value;
    }
    if (!match && body.contentType && !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
      headers["Content-Type"] = body.contentType;
    }
    const query = [...url.query, ...auth.query].map(({ key, value }) => ({
      key,
      value: looksSecret(key) ? secrets.keep(key, value) : value,
    }));

    const scripts = scriptsOf(item.events);
    const facts = scripts.test ? readTestScript(scripts.test) : null;
    let expect: CollectionStep["expect"];
    if (facts?.status && facts.status !== DEFAULT_EXPECTED_STATUS) expect = { status: facts.status };

    const taken = collection.steps.map((s) => s.key);
    const nameKey = keyFromName(item.name.split(" / ").pop() ?? "");
    let step: CollectionStep = {
      key: uniqueStepKey(match ? baseStepKey(match.op) : nameKey || `${method.toLowerCase()}Request`, taken),
      name: item.name,
      request: {
        method,
        url: `${withScheme(fillPathVars(url.base, url.pathVars))}${query.length ? `?${query.map((q) => `${q.key}=${q.value}`).join("&")}` : ""}`,
      },
      pathParams: match ? match.pathParams : {},
      queryParams: match ? Object.fromEntries(query.map((q) => [q.key, q.value])) : {},
      headers,
      ...(body.body !== undefined ? { body: body.body } : {}),
      ...(auth.auth ? { auth: auth.auth } : {}),
      ...(expect ? { expect } : {}),
    };
    collection = { ...collection, steps: [...collection.steps, step] };
    const index = collection.steps.length - 1;

    if (match) {
      const declared = new Set(match.op.parameters.filter((p) => p.in === "query").map((p) => p.name));
      const dropped = query.filter((q) => !declared.has(q.key)).map((q) => q.key);
      if (dropped.length) {
        notes.push(
          `The query parameter${dropped.length > 1 ? "s" : ""} ${dropped.join(", ")} ${dropped.length > 1 ? "aren't" : "isn't"} in the spec, so ${dropped.length > 1 ? "they were" : "it was"} left out.`,
        );
      }
      collection = relinkStep(collection, index, match.entry, match.op);
      step = collection.steps[index];
      // Where Postman sent it: a declared server other than the first, or the
      // variable / local address it used when the host wasn't one of the spec's.
      let target: StepTarget | undefined;
      if (match.server && match.server !== match.spec.servers[0]) target = { kind: "server", url: match.server };
      else if (!match.server) {
        const prefixPath = where.written.slice(0, match.prefix).join("/");
        const origin = where.hostVariable ? `{{${where.hostVariable}}}` : where.origin;
        if (origin) target = { kind: "custom", url: `${origin}${prefixPath ? `/${prefixPath}` : ""}` };
        else if (!match.spec.servers.length) notes.push("The spec declares no server, and the request had none Studio could read. Pick a target for this step.");
      }
      if (target) step = { ...step, target };
      collection = { ...collection, steps: collection.steps.map((s, i) => (i === index ? step : s)) };
    } else {
      summary.notInSpec.push({ key: step.key, label: `${method} ${step.request?.url ?? ""}`, reason: decision.kind === "unlinked" ? decision.reason : "" });
      if (decision.kind === "unlinked") notes.unshift(`Not in any spec when imported: ${decision.reason}`);
    }

    if (scripts.prerequest || scripts.test) {
      summary.scripts += 1;
      const kinds = [scripts.prerequest && "pre-request", scripts.test && "test"].filter(Boolean).join(" and ");
      let line = `This step had a Postman ${kinds} script; Studio doesn't run scripts.`;
      if (expect) line += ` Its status check became the expected status (${expect.status}).`;
      else if (facts?.statusAmbiguous) line += " It checks more than one status, so the step expects any 2xx; set the one you mean.";
      notes.push(line);
      if (expect) summary.statuses.push({ key: step.key, status: expect.status });
    }
    for (const set of facts?.sets ?? []) setters.push({ index, variable: set.variable, source: set.source });
    for (const m of scripts.prerequest.matchAll(
      /(?:pm\.(?:environment|collectionVariables|globals|variables)\.set|postman\.set(?:Environment|Global)Variable)\(\s*(['"`])([^'"`]+)\1/g,
    )) {
      setters.push({ index, variable: m[2], source: null });
    }
    if (notes.length) {
      collection = {
        ...collection,
        steps: collection.steps.map((s, i) => (i === index ? { ...s, note: notes.join("\n") } : s)),
      };
    }
  }

  // Variables a script set, as references in the later steps that use them.
  const byVariable = new Map<string, typeof setters>();
  for (const set of setters) byVariable.set(set.variable, [...(byVariable.get(set.variable) ?? []), set]);
  for (const [variable, sets] of byVariable) {
    const laterUse = collection.steps.some((s, i) => i > Math.min(...sets.map((x) => x.index)) && usesVariable(s, variable));
    if (!laterUse) continue;
    const convertible = sets.length === 1 && sets[0].source !== null;
    if (!convertible) {
      summary.unchained.push({
        variable,
        reason:
          sets.length > 1
            ? "more than one step sets it"
            : "the script works it out in a way Studio can't follow",
      });
      continue;
    }
    const { index, source } = sets[0];
    const key = collection.steps[index].key;
    const reference =
      source!.kind === "header" ? referenceFor(key, ["headers", source!.name]) : referenceFor(key, ["body", ...source!.path]);
    const pattern = new RegExp(`\\{\\{\\s*${variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\}\\}`, "g");
    collection = {
      ...collection,
      steps: collection.steps.map((s, i) => (i > index ? rewriteStep(s, (text) => text.replace(pattern, reference)) : s)),
    };
    summary.chained.push({ variable, reference });
  }

  // Postman's dynamic variables have no Studio equivalent.
  const dynamic = new Set<string>();
  for (const step of collection.steps) {
    rewriteStep(step, (text) => {
      for (const m of text.matchAll(/\{\{\s*(\$[A-Za-z]+)\s*\}\}/g)) dynamic.add(m[1]);
      return text;
    });
  }
  if (dynamic.size) {
    warnings.push(
      `Postman's generated values (${[...dynamic].map((d) => `{{${d}}}`).join(", ")}) aren't supported. Put a value for each in an environment.`,
    );
  }
  if (collectionScripts.prerequest || collectionScripts.test) {
    warnings.push("The collection itself had scripts. Studio doesn't run scripts, so they weren't brought across.");
  }
  if (folderScripts.length) {
    warnings.push(
      `The folder${folderScripts.length > 1 ? "s" : ""} ${folderScripts.join(", ")} had scripts. Studio doesn't run scripts, so they weren't brought across.`,
    );
  }

  const counts = new Map<string, number>();
  for (const step of collection.steps) {
    if (!step.api) continue;
    const title = collection.apis[step.api]?.title ?? step.api;
    counts.set(title, (counts.get(title) ?? 0) + 1);
  }
  summary.linked = [...counts].map(([api, count]) => ({ api, count }));

  const variables: Variable[] = [
    ...collectionVars,
    ...[...secrets.values].map(([varName, value]) => ({ name: varName, value, secret: true })),
  ];
  return {
    collection,
    environment: variables.length ? { name, variables } : null,
    summary,
  };
}
