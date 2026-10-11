import type { AgentApp } from "./agentApp";
import type { ActivityEntry } from "./agentControl";
import { parseBodyPath, collectionLinks, dependentsOf, describeLinkTarget, describeSourcePath, schemaTypeAt, setLink, type LinkTarget } from "./chainLinks";
import { referenceFor, type PathSegment } from "./chain";
import {
  describeExpected,
  isValidStepKey,
  moveStep,
  newCollection,
  newCollectionId,
  normaliseExpectedStatus,
  renameStepKey,
  type Collection,
  type CollectionStep,
  type StepTarget,
} from "./collection";
import { addOperationStep, describeTarget, linkStep, localMockAddress, removeStep, resolveTarget } from "./collectionLink";
import { describeRun, summariseRun, type StepResult } from "./collectionRun";
import { withCollectionSuffix } from "./collectionFile";
import { transportFor } from "./connection";
import { unresolved } from "./env";
import type { HistoryEntry } from "./history";
import { checkFields, fingerprint } from "./history";
import { documentUrlOf, type LibraryEntry } from "./library";
import { localMockUrl } from "./localMockServer";
import { findApi, findOperation, specFor, type ToolResult } from "./mcp";
import { buildPlan, describeBody, type AuthState, type RequestPlan, type ResponseResult, type Transport } from "./request";
import { declaredResponse, storedResponseBody } from "./response";
import { describeSkip, describeSummary, isSafeMethod, planRun, summarise, type RunResult } from "./runner";
import { runLogJson, runLogText } from "./runLog";
import { buildScratchPlan, SCRATCH_OPERATION_ID, SCRATCH_TITLE, scratchPath } from "./scratch";
import { parseSpec, type Json, type OperationSpec, type ParsedSpec } from "./spec";
import { noChanges, specChanges, specProblems } from "./specCheck";
import { mockCredentials, sentToMock } from "./targets";
import { validateResponse, type ValidationResult } from "./validate";

/**
 * The local MCP server's tools that act: sending requests, checking a running
 * server against its spec, local mocks, building and running collections, and
 * reloading specs. `mcp.ts` has the tools that only read.
 *
 * Every request goes through the developer's approval first (`agentControl.ts`
 * decides when to ask), through the same send path as the rest of Studio, and
 * is logged in the console, in History and in the Agents activity view. The
 * agent refers to values as `{{name}}`; Studio fills them in from the active
 * environment, and secret values never come back: credential headers are
 * hidden in what is returned, and every result is redacted on its way out
 * (`mcpServer.ts`).
 *
 * Collections an agent creates are drafts, and agents can only change their
 * own drafts. A collection the developer made or kept is read-only to them;
 * `create_collection` with `copy_of` gives them a copy to work on.
 */

export interface ToolContext {
  /** The agent calling, as Studio names it. */
  agent: string;
}

/** What these tools use. Injected so they can be tested without Tauri or React. */
export interface AgentToolDeps {
  /** The running app, once it has registered. */
  app: () => AgentApp | null;
  loadLibrary: () => Promise<LibraryEntry[]>;
  readSpecText: (id: string) => Promise<string | null>;
  send: (plan: RequestPlan, transport: Transport, meta: { agent: string }) => Promise<ResponseResult>;
  gateRequest: (agent: string, request: { method: string; url: string }) => Promise<string | null>;
  gateMockStart: (agent: string, api: string) => Promise<string | null>;
  gateSave: (agent: string, collection: string, path: string, replaces: boolean) => Promise<string | null>;
  /** Bumped when the developer stops agents. */
  stopGeneration: () => number;
  recordActivity: (entry: Omit<ActivityEntry, "id" | "at">) => void;
  recordHistory: (entry: Omit<HistoryEntry, "id" | "at">) => Promise<unknown>;
  /** A file's text, or null when it can't be read. */
  readFile: (path: string) => Promise<string | null>;
  /** A file-backed spec, read again from disk. */
  rereadFile: (entry: LibraryEntry) => Promise<string | null>;
  fetchText: (url: string) => Promise<string>;
  applyUpdate: (
    id: string,
    input: { text: string; title: string; version: string; operations: number; schemas: number },
  ) => Promise<unknown>;
  /** The library file changed for this entry's spec; tell the interface. */
  specChanged: (id: string) => void;
}

type Tool = (args: Json, deps: AgentToolDeps, context: ToolContext) => Promise<ToolResult>;

/** Longest response body returned to an agent. History keeps more. */
export const MAX_RETURNED_BODY = 20_000;
/** Findings listed per response. */
const MAX_FINDINGS = 20;

function text(value: unknown): ToolResult {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function str(args: Json, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringMap(args: Json, key: string): Record<string, string> {
  const value = args[key];
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${key} must be an object of names to values.`);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== null && item !== undefined)
      .map(([name, item]) => [name, typeof item === "string" ? item : JSON.stringify(item)]),
  );
}

/** A body argument as the editor holds it: JSON values pretty-printed, strings as they are. */
function bodyText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function requireApp(deps: AgentToolDeps): AgentApp {
  const app = deps.app();
  if (!app) throw new Error("Studio's window isn't ready yet. Try again in a moment.");
  return app;
}

// Targets

/**
 * A target argument: "server" is the spec's first server (no target), "mock",
 * "local-mock", or a base URL.
 */
export function parseTarget(value: string | undefined): StepTarget | undefined {
  if (!value || value === "server") return undefined;
  if (value === "mock") return { kind: "mock" };
  if (value === "local-mock") return { kind: "local-mock" };
  if (!/^https?:\/\//i.test(value)) {
    throw new Error(`target must be "server", "mock", "local-mock" or a URL starting with http:// or https://, not "${value}".`);
  }
  return { kind: "custom", url: value.replace(/\/+$/, "") };
}

function baseUrlFor(target: StepTarget | undefined, entry: LibraryEntry, spec: ParsedSpec, app: AgentApp): { url: string; mock: boolean } {
  const resolved = resolveTarget(target, {
    servers: spec.servers,
    mockUrl: entry.mockUrl ?? null,
    localMockUrl: localMockAddress(app.localMocks.running()[entry.id]),
  });
  if ("error" in resolved) {
    throw new Error(
      target?.kind === "local-mock"
        ? `${entry.title} has no local mock running. Start one with start_local_mock, or pick another target.`
        : resolved.error,
    );
  }
  return resolved;
}

// What goes back to the agent

/** Headers whose values are credentials. Hidden in results unless they are only `{{references}}`. */
const CREDENTIAL_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "x-mock-api-key",
  "x-auth-token",
]);

const ONLY_REFERENCES = /^(?:[A-Za-z]+\s+)?(?:\{\{[^}]+\}\}\s*)+$/;

/**
 * Headers as an agent sees them: a credential header is shown only when its
 * value is a `{{reference}}` (it was redacted already, or the agent wrote it).
 * Anything else, such as an OAuth token Studio fetched, becomes "(hidden)".
 */
export function maskHeaders(headers: Record<string, string>, extra: string[] = []): Record<string, string> {
  const hidden = new Set([...CREDENTIAL_HEADERS, ...extra.map((name) => name.toLowerCase())]);
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      hidden.has(name.toLowerCase()) && !ONLY_REFERENCES.test(value.trim()) ? "(hidden)" : value,
    ]),
  );
}

/** A URL with the API key's query parameter hidden, when the scheme puts it there. */
export function maskUrl(url: string, queryNames: string[]): string {
  if (!queryNames.length) return url;
  try {
    const parsed = new URL(url);
    let changed = false;
    for (const name of queryNames) {
      const value = parsed.searchParams.get(name);
      if (value !== null && !ONLY_REFERENCES.test(value)) {
        parsed.searchParams.set(name, "(hidden)");
        changed = true;
      }
    }
    return changed ? parsed.toString() : url;
  } catch {
    return url;
  }
}

function clipBody(body: string): { body: string; truncated?: true } {
  return body.length > MAX_RETURNED_BODY
    ? { body: `${body.slice(0, MAX_RETURNED_BODY)}…`, truncated: true }
    : { body };
}

function schemaResult(validation: ValidationResult | null) {
  if (!validation) return { result: "not_checked", note: "This request isn't linked to an operation in a spec." };
  return {
    result: validation.status === "no_schema" ? "not_checked" : validation.status,
    ...(validation.note ? { note: validation.note } : {}),
    ...(validation.findings.length
      ? {
          findings: validation.findings.slice(0, MAX_FINDINGS).map((finding) => ({ path: finding.path || "(root)", message: finding.message })),
          ...(validation.findings.length > MAX_FINDINGS ? { moreFindings: validation.findings.length - MAX_FINDINGS } : {}),
        }
      : {}),
  };
}

// Sending

interface Prepared {
  plan: RequestPlan;
  entry: LibraryEntry | null;
  spec: ParsedSpec | null;
  op: OperationSpec | null;
  toMock: boolean;
  mockUrl: string | null;
  /** Header and query names that carry the API's credential. */
  credentialHeaders: string[];
  credentialQuery: string[];
}

/** The security scheme an operation uses, as a sendable auth state, or null. */
async function authFor(
  op: OperationSpec,
  spec: ParsedSpec,
  entry: LibraryEntry,
  value: string | undefined,
  app: AgentApp,
): Promise<AuthState | null> {
  const names = op.security ?? spec.securitySchemes.map((scheme) => scheme.name);
  const scheme = spec.securitySchemes.find((candidate) => names.includes(candidate.name));
  if (!scheme) return null;
  const base = { schemeName: scheme.name, type: scheme.type, httpScheme: scheme.scheme, in: scheme.in, paramName: scheme.paramName };
  if (value !== undefined) return { ...base, value };
  if (scheme.type === "oauth2" || scheme.type === "openIdConnect") {
    const token = await app.oauthToken(entry);
    return token ? { ...base, type: "oauth2", value: token } : null;
  }
  return null;
}

async function prepareRequest(args: Json, deps: AgentToolDeps, app: AgentApp): Promise<Prepared> {
  const vars = app.vars();
  const headers = stringMap(args, "headers");
  const body = bodyText(args.body);

  if (!str(args, "api")) {
    const method = str(args, "method");
    const url = str(args, "url");
    if (!method || !url) throw new Error("Pass api with operation_id (or method and path), or method and url for a request that isn't in a spec.");
    const plan = buildScratchPlan(
      { method, url, headers: Object.entries(headers).map(([key, value]) => ({ key, value })), body: body ?? "" },
      vars,
    );
    return { plan, entry: null, spec: null, op: null, toMock: false, mockUrl: null, credentialHeaders: [], credentialQuery: [] };
  }

  const entry = findApi(await deps.loadLibrary(), str(args, "api"));
  const spec = await specFor(entry, deps);
  const selector = { operationId: str(args, "operation_id"), method: str(args, "method"), path: str(args, "path") };
  if (!selector.operationId && !(selector.method && selector.path)) throw new Error("Pass operation_id, or both method and path.");
  const op = findOperation(spec.operations, selector);
  if (!op) throw new Error(`No operation ${selector.operationId ?? `${selector.method} ${selector.path}`} in ${entry.title}. search_operations finds one.`);

  const pathParams = stringMap(args, "path_params");
  const missing = op.parameters.filter((param) => param.in === "path" && !pathParams[param.name]).map((param) => param.name);
  if (missing.length) throw new Error(`Pass path_params for ${missing.join(", ")}.`);

  const base = baseUrlFor(parseTarget(str(args, "target")), entry, spec, app);
  const auth = await authFor(op, spec, entry, typeof args.auth_value === "string" ? args.auth_value : undefined, app);
  const mock = mockCredentials(entry.mockUrl ?? null, entry.mockApiKey, app.session());
  const plan = buildPlan(op, base.url, pathParams, stringMap(args, "query"), headers, auth, body ?? "", vars, mock);
  const paramName = auth?.paramName ? [auth.paramName] : [];
  return {
    plan,
    entry,
    spec,
    op,
    toMock: base.mock,
    mockUrl: entry.mockUrl ?? null,
    credentialHeaders: auth?.in === "header" ? paramName : [],
    credentialQuery: auth?.in === "query" ? paramName : [],
  };
}

/** Values the request still names but the active environment doesn't have. */
function missingValues(plan: RequestPlan, vars: Record<string, string>): string[] {
  const bodyPart = plan.body?.kind === "text" ? plan.body.text : plan.body?.kind === "form" ? plan.body.fields.map(([, v]) => v).join("\n") : "";
  let url = plan.url;
  try {
    url = decodeURIComponent(plan.url);
  } catch {
    // Not consistently encoded; check it as it is.
  }
  return unresolved([url, ...Object.values(plan.headers), bodyPart].join("\n"), vars);
}

/** Send one prepared request, after the gate, and record it everywhere the developer looks. */
async function sendForAgent(
  prepared: Prepared,
  deps: AgentToolDeps,
  app: AgentApp,
  context: ToolContext,
  extra: { runId?: string } = {},
): Promise<{ response: ResponseResult; validation: ValidationResult | null } | { refused: string } | { error: string }> {
  const { plan, entry, spec, op } = prepared;
  const refused = await deps.gateRequest(context.agent, { method: plan.method, url: plan.url });
  const shownUrl = maskUrl(plan.url, prepared.credentialQuery);
  if (refused) {
    deps.recordActivity({ agent: context.agent, tool: "request", ok: false, summary: `Not sent: ${plan.method} ${shownUrl}. ${refused}`, sent: { method: plan.method, url: shownUrl } });
    return { refused };
  }
  let response: ResponseResult;
  try {
    response = await deps.send(plan, { ...transportFor(app.connection(), plan.url), jar: entry?.id ?? "__scratch__" }, { agent: context.agent });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.recordActivity({ agent: context.agent, tool: "request", ok: false, summary: `${plan.method} ${shownUrl} failed: ${message}`, sent: { method: plan.method, url: shownUrl } });
    return { error: message };
  }
  const validation = op && spec ? validateResponse(spec.doc, declaredResponse(op.responses, response.status)?.schema, response.json) : null;
  await deps.recordHistory({
    method: plan.method,
    path: op ? op.path : scratchPath(plan.url),
    url: plan.url,
    status: response.status,
    ms: response.ms,
    bytes: response.bytes,
    specTitle: spec ? spec.title || entry!.title : SCRATCH_TITLE,
    operationId: op ? op.id : SCRATCH_OPERATION_ID,
    ...(entry ? { apiId: entry.id } : {}),
    environment: app.environment()?.name,
    headers: plan.headers,
    body: describeBody(plan.body),
    bodyKind: plan.body?.kind,
    ...(validation && spec
      ? checkFields(validation, { version: spec.version, fingerprint: fingerprint(spec.sourceText) })
      : { validation: "no_schema" as const }),
    mock: prepared.toMock || sentToMock(plan.url, prepared.mockUrl),
    statusText: response.statusText,
    responseHeaders: response.headers,
    responseBody: storedResponseBody(response),
    ...(extra.runId ? { runId: extra.runId } : {}),
  }).catch(() => undefined);
  deps.recordActivity({
    agent: context.agent,
    tool: "request",
    ok: response.status < 400 && validation?.status !== "mismatch",
    summary: `${plan.method} ${shownUrl} → ${response.status} · ${response.ms} ms${validation?.status === "mismatch" ? " · doesn't match the spec" : ""}`,
    sent: {
      method: plan.method,
      url: shownUrl,
      headers: maskHeaders(plan.headers, prepared.credentialHeaders),
      ...(plan.body ? { body: describeBody(plan.body) } : {}),
    },
    received: { status: response.status, ms: response.ms, bytes: response.bytes, body: response.binary ? undefined : response.bodyText },
  });
  return { response, validation };
}

const sendRequest: Tool = async (args, deps, context) => {
  const app = requireApp(deps);
  const prepared = await prepareRequest(args, deps, app);
  const missing = missingValues(prepared.plan, app.vars());
  if (missing.length) {
    const env = app.environment();
    return fail(
      `No value for ${missing.map((name) => `{{${name}}}`).join(", ")} in ${env ? `the active environment, ${env.name}` : "an environment: none is active"}. list_environments shows the names there; ask the user to add what's missing.`,
    );
  }
  const sent = await sendForAgent(prepared, deps, app, context);
  if ("refused" in sent) return fail(sent.refused);
  if ("error" in sent) return fail(`The request failed before a response came back: ${sent.error}`);
  const { response, validation } = sent;
  const { plan } = prepared;
  return text({
    request: {
      method: plan.method,
      url: maskUrl(plan.url, prepared.credentialQuery),
      headers: maskHeaders(plan.headers, prepared.credentialHeaders),
      ...(prepared.toMock ? { sentTo: "a mock" } : {}),
    },
    response: {
      status: response.status,
      statusText: response.statusText,
      ms: response.ms,
      bytes: response.bytes,
      headers: maskHeaders(response.headers),
      ...(response.binary
        ? { body: null, binary: { contentType: response.binary.contentType, bytes: response.binary.byteLength } }
        : clipBody(response.bodyText)),
    },
    matchesSpec: schemaResult(validation),
    ...(response.headers["x-spec0-mock-warnings"] ? { mockWarnings: response.headers["x-spec0-mock-warnings"].split(/;\s+/) } : {}),
    note: "Recorded in Studio's History. Credentials are shown as {{names}} or (hidden).",
  });
};

const checkContract: Tool = async (args, deps, context) => {
  const app = requireApp(deps);
  const entry = findApi(await deps.loadLibrary(), str(args, "api"));
  const spec = await specFor(entry, deps);
  const target = parseTarget(str(args, "target"));
  const base = baseUrlFor(target, entry, spec, app);
  const wanted = Array.isArray(args.operations) ? args.operations.filter((item): item is string => typeof item === "string") : [];
  const operations = wanted.length
    ? wanted.map((ref) => {
        const [method, ...rest] = ref.trim().split(/\s+/);
        const op = rest.length ? findOperation(spec.operations, { method, path: rest.join(" ") }) : findOperation(spec.operations, { operationId: ref.trim() });
        if (!op) throw new Error(`No operation ${ref} in ${entry.title}.`);
        return op;
      })
    : spec.operations;
  const vars = app.vars();
  const planned = planRun(operations, vars, { includeMutating: args.include_mutating === true });
  const mock = mockCredentials(entry.mockUrl ?? null, entry.mockApiKey, app.session());
  const runId = `run_${Date.now().toString(36)}`;
  const generation = deps.stopGeneration();
  const results: RunResult[] = [];
  let stopped: string | null = null;
  for (const item of planned) {
    if (stopped || item.skip || deps.stopGeneration() !== generation) {
      results.push({ operation: item.operation, verdict: "skipped", ...(item.skip ? { skip: item.skip } : {}), ...(stopped || !item.skip ? { error: stopped ?? "Agents were stopped." } : {}) });
      continue;
    }
    let plan: RequestPlan;
    try {
      const auth = await authFor(item.operation, spec, entry, undefined, app);
      plan = buildPlan(item.operation, base.url, item.pathParams, item.queryParams, {}, auth, "", vars, mock);
    } catch (error) {
      results.push({ operation: item.operation, verdict: "error", error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const sent = await sendForAgent({ plan, entry, spec, op: item.operation, toMock: base.mock, mockUrl: entry.mockUrl ?? null, credentialHeaders: [], credentialQuery: [] }, deps, app, context, { runId });
    if ("refused" in sent) {
      // Asking again for every remaining operation would only repeat the question.
      stopped = sent.refused;
      results.push({ operation: item.operation, verdict: "skipped", error: stopped });
      continue;
    }
    if ("error" in sent) {
      results.push({ operation: item.operation, verdict: "error", error: sent.error });
      continue;
    }
    results.push({ operation: item.operation, verdict: sent.validation?.status ?? "no_schema", status: sent.response.status, ms: sent.response.ms, ...(sent.validation ? { validation: sent.validation } : {}) });
  }
  app.historyChanged();
  const summary = summarise(results);
  return text({
    api: { id: entry.id, title: entry.title },
    target: base.url,
    summary: describeSummary(summary),
    counts: summary,
    results: results.map((result) => ({
      operation: `${result.operation.method} ${result.operation.path}`,
      ...(result.operation.operationId ? { operationId: result.operation.operationId } : {}),
      result: result.verdict === "ok" ? "matches" : result.verdict === "no_schema" ? "not_checked" : result.verdict,
      ...(result.status !== undefined ? { status: result.status, ms: result.ms } : {}),
      ...(result.skip ? { reason: describeSkip(result.skip) } : result.error ? { reason: result.error } : {}),
      ...(result.validation?.findings.length
        ? { findings: result.validation.findings.slice(0, MAX_FINDINGS).map((finding) => ({ path: finding.path || "(root)", message: finding.message })) }
        : {}),
    })),
    ...(stopped ? { stopped } : {}),
    note: !isSafeMethodsOnly(operations) && args.include_mutating !== true ? "POST, PUT, PATCH and DELETE operations were skipped. Pass include_mutating to run them." : undefined,
  });
};

function isSafeMethodsOnly(operations: OperationSpec[]): boolean {
  return operations.every((op) => isSafeMethod(op.method));
}

// Local mocks

const listLocalMocks: Tool = async (_args, deps) => {
  const app = requireApp(deps);
  const entries = await deps.loadLibrary();
  const running = Object.entries(app.localMocks.running()).map(([id, port]) => {
    const entry = entries.find((row) => row.id === id);
    return { api: { id, title: entry?.title ?? id }, url: localMockUrl(port) };
  });
  return text({
    running,
    ...(running.length ? {} : { note: "No local mocks are running. start_local_mock starts one." }),
  });
};

const startLocalMock: Tool = async (args, deps, context) => {
  const app = requireApp(deps);
  const entry = findApi(await deps.loadLibrary(), str(args, "api"));
  const already = app.localMocks.running()[entry.id];
  if (already) return text({ api: { id: entry.id, title: entry.title }, url: localMockUrl(already), started: false, note: "It was already running." });
  const refused = await deps.gateMockStart(context.agent, entry.title);
  if (refused) return fail(refused);
  const port = await app.localMocks.start(entry);
  deps.recordActivity({ agent: context.agent, tool: "start_local_mock", ok: true, summary: `Started a local mock of ${entry.title} at ${localMockUrl(port)}` });
  return text({
    api: { id: entry.id, title: entry.title },
    url: localMockUrl(port),
    started: true,
    note: "Paths from the spec work unchanged under this address. Choose a response with the header Prefer: code=404. Problems with a request are listed in the X-Spec0-Mock-Warnings response header.",
  });
};

const stopLocalMock: Tool = async (args, deps, context) => {
  const app = requireApp(deps);
  const entry = findApi(await deps.loadLibrary(), str(args, "api"));
  if (!app.localMocks.running()[entry.id]) return text(`${entry.title} has no local mock running.`);
  await app.localMocks.stop(entry.id);
  deps.recordActivity({ agent: context.agent, tool: "stop_local_mock", ok: true, summary: `Stopped the local mock of ${entry.title}` });
  return text(`Stopped the local mock of ${entry.title}.`);
};

// Collections

/** A collection by id, then exact name, then a name that uniquely contains the text. */
export function findCollection(collections: readonly Collection[], ref: string | undefined): Collection {
  if (!ref) throw new Error("Say which collection: pass `collection` with an id or name from list_collections.");
  const byId = collections.find((collection) => collection.id === ref);
  if (byId) return byId;
  const lowered = ref.toLowerCase();
  const exact = collections.filter((collection) => collection.name.toLowerCase() === lowered);
  if (exact.length === 1) return exact[0];
  const partial = exact.length ? exact : collections.filter((collection) => collection.name.toLowerCase().includes(lowered));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new Error(`More than one collection matches "${ref}": ${partial.map((c) => `${c.name} (id ${c.id})`).join(", ")}. Pass the id.`);
  }
  throw new Error(`No collection called "${ref}". list_collections shows what's there.`);
}

/** Agents change only the drafts they made; anything else is the developer's. */
export function requireDraft(collection: Collection): void {
  if (!collection.draft) {
    throw new Error(
      `${collection.name} isn't a draft, so agents can't change it. Create a copy to work on with create_collection and copy_of, or ask the user to change it.`,
    );
  }
}

function stepIndex(collection: Collection, key: string | undefined): number {
  if (!key) throw new Error("Pass step with a step key from get_collection.");
  const index = collection.steps.findIndex((step) => step.key === key);
  if (index < 0) throw new Error(`${collection.name} has no step ${key}. Its steps are: ${collection.steps.map((step) => step.key).join(", ") || "none"}.`);
  return index;
}

/** Change a draft through the app, so the interface shows it at once. */
function changeDraft(app: AgentApp, ref: string | undefined, change: (collection: Collection) => Collection): Collection {
  const collection = findCollection(app.collections.list(), ref);
  requireDraft(collection);
  const changed = change(collection);
  const after = app.collections.change(collection.id, () => changed);
  if (!after) throw new Error(`${collection.name} was removed in Studio.`);
  return after;
}

async function specsFor(entries: readonly LibraryEntry[], deps: AgentToolDeps): Promise<Map<string, ParsedSpec | null>> {
  const specs = new Map<string, ParsedSpec | null>();
  for (const entry of entries) {
    try {
      specs.set(entry.id, await specFor(entry, deps));
    } catch {
      specs.set(entry.id, null);
    }
  }
  return specs;
}

function describeStepTarget(step: CollectionStep): string {
  if (!step.target) return "server";
  return step.target.kind === "custom" ? step.target.url : step.target.kind === "server" ? step.target.url : step.target.kind;
}

const listCollections: Tool = async (_args, deps) => {
  const app = requireApp(deps);
  const collections = app.collections.list();
  return text({
    count: collections.length,
    collections: collections.map((collection) => {
      const last = app.collections.runLogs(collection.id)[0];
      return {
        id: collection.id,
        name: collection.name,
        steps: collection.steps.length,
        draft: collection.draft ? { by: collection.draft.by } : false,
        ...(collection.file ? { file: collection.file.path } : {}),
        ...(last
          ? { lastRun: { runId: last.id, at: last.startedAt, ...(last.counts ? { counts: last.counts } : { running: true }) } }
          : {}),
      };
    }),
    ...(collections.length ? {} : { note: "There are no collections yet. create_collection makes a draft." }),
  });
};

const getCollection: Tool = async (args, deps) => {
  const app = requireApp(deps);
  const collection = findCollection(app.collections.list(), str(args, "collection"));
  const entries = await deps.loadLibrary();
  const specs = await specsFor(entries, deps);
  const links = collectionLinks(collection);
  return text({
    id: collection.id,
    name: collection.name,
    draft: collection.draft ? { by: collection.draft.by } : false,
    ...(collection.file ? { file: collection.file.path } : {}),
    stopOnFailure: collection.stopOnFailure,
    editable: Boolean(collection.draft),
    steps: collection.steps.map((step, index) => {
      const link = linkStep(step, collection, entries, specs);
      const api = step.api ? collection.apis[step.api] : undefined;
      return {
        key: step.key,
        ...(step.name ? { name: step.name } : {}),
        ...(api ? { api: api.title } : {}),
        ...(step.operation
          ? { operation: `${step.operation.method} ${step.operation.path}`, ...(step.operation.operationId ? { operationId: step.operation.operationId } : {}) }
          : step.request
            ? { request: `${step.request.method} ${step.request.url}` }
            : {}),
        target: link.kind === "ok" || link.kind === "stale" ? describeTarget(step.target, link.spec) : describeStepTarget(step),
        ...(Object.keys(step.pathParams).length ? { pathParams: step.pathParams } : {}),
        ...(Object.keys(step.queryParams).length ? { query: step.queryParams } : {}),
        ...(Object.keys(step.headers).length ? { headers: maskHeaders(step.headers) } : {}),
        ...(step.body !== undefined ? { body: typeof step.body === "string" ? step.body : step.body } : {}),
        expects: describeExpected(step.expect?.status),
        ...(links.some((l) => l.targetIndex === index)
          ? {
              usesValues: links
                .filter((l) => l.targetIndex === index)
                .map((l) => ({ field: describeLinkTarget(l.target), from: `${l.source.step}.${describeSourcePath(l.source.path)}` })),
            }
          : {}),
        ...(link.kind === "unresolved" ? { problem: link.reason } : link.kind === "stale" ? { problem: link.reasons.join(" ") } : {}),
        ...(step.note ? { note: step.note } : {}),
      };
    }),
  });
};

const createCollection: Tool = async (args, deps, context) => {
  const app = requireApp(deps);
  const name = str(args, "name");
  if (!name) throw new Error("Pass a name.");
  const source = str(args, "copy_of") ? findCollection(app.collections.list(), str(args, "copy_of")) : null;
  const base = source
    ? { ...structuredClone(source), id: newCollectionId(), name, file: undefined }
    : newCollection(name);
  const collection: Collection = { ...base, name, draft: { by: context.agent, at: new Date().toISOString() }, updatedAt: new Date().toISOString() };
  delete collection.file;
  app.collections.add(collection);
  deps.recordActivity({ agent: context.agent, tool: "create_collection", ok: true, summary: `Created the draft collection ${name}${source ? `, a copy of ${source.name}` : ""}` });
  return text({
    id: collection.id,
    name,
    draft: true,
    steps: collection.steps.map((step) => step.key),
    note: "It shows in Studio as a draft. The user can keep it, save it to a file, or discard it. Add steps with add_step.",
  });
};

const addStep: Tool = async (args, deps, context) => {
  const app = requireApp(deps);
  const entry = findApi(await deps.loadLibrary(), str(args, "api"));
  const spec = await specFor(entry, deps);
  const selector = { operationId: str(args, "operation_id"), method: str(args, "method"), path: str(args, "path") };
  if (!selector.operationId && !(selector.method && selector.path)) throw new Error("Pass operation_id, or both method and path.");
  const op = findOperation(spec.operations, selector);
  if (!op) throw new Error(`No operation ${selector.operationId ?? `${selector.method} ${selector.path}`} in ${entry.title}.`);
  const target = parseTarget(str(args, "target"));
  const wantedKey = str(args, "key");
  if (wantedKey && !isValidStepKey(wantedKey)) throw new Error("A step key uses letters, digits, - and _, starting with a letter.");
  const expect = str(args, "expect_status");
  const status = expect ? normaliseExpectedStatus(expect) : null;
  if (expect && !status) throw new Error(`expect_status must be a status such as "201" or "4XX", not "${expect}".`);
  const body = bodyText(args.body);
  let key = "";
  const after = changeDraft(app, str(args, "collection"), (collection) => {
    let next = addOperationStep(collection, entry, spec, op, undefined, target);
    const index = next.steps.length - 1;
    const added = next.steps[index];
    const patched: CollectionStep = {
      ...added,
      ...(str(args, "name") ? { name: str(args, "name") } : {}),
      pathParams: { ...added.pathParams, ...stringMap(args, "path_params") },
      queryParams: { ...added.queryParams, ...stringMap(args, "query") },
      headers: { ...added.headers, ...stringMap(args, "headers") },
      ...(body !== undefined ? { body } : {}),
      ...(status && status !== "2XX" ? { expect: { status } } : {}),
    };
    next = { ...next, steps: next.steps.map((step, i) => (i === index ? patched : step)) };
    key = patched.key;
    if (wantedKey && wantedKey !== key) {
      next = renameStepKey(next, key, wantedKey);
      key = wantedKey;
    }
    if (typeof args.position === "number" && Number.isInteger(args.position)) next = moveStep(next, index, args.position);
    return next;
  });
  deps.recordActivity({ agent: context.agent, tool: "add_step", ok: true, summary: `Added ${op.method} ${op.path} to ${after.name} as ${key}` });
  return text({
    collection: after.name,
    step: key,
    position: after.steps.findIndex((step) => step.key === key),
    operation: `${op.method} ${op.path}`,
    note: `Later steps can use its response as {{steps.${key}.body.<field>}}; link_value writes that for you.`,
  });
};

function mergeMap(current: Record<string, string>, value: unknown, key: string): Record<string, string> {
  if (value === undefined) return current;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${key} must be an object of names to values.`);
  const next = { ...current };
  for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === null) delete next[name];
    else next[name] = typeof item === "string" ? item : JSON.stringify(item);
  }
  return next;
}

const updateStep: Tool = async (args, deps, context) => {
  const app = requireApp(deps);
  const target = args.target === undefined ? undefined : parseTarget(str(args, "target"));
  const after = changeDraft(app, str(args, "collection"), (collection) => {
    const index = stepIndex(collection, str(args, "step"));
    const step = collection.steps[index];
    const body = bodyText(args.body);
    const next: CollectionStep = {
      ...step,
      ...(str(args, "name") ? { name: str(args, "name") } : {}),
      pathParams: mergeMap(step.pathParams, args.path_params, "path_params"),
      queryParams: mergeMap(step.queryParams, args.query, "query"),
      headers: mergeMap(step.headers, args.headers, "headers"),
      ...(body !== undefined ? { body } : {}),
    };
    if (args.target !== undefined) {
      if (target) next.target = target;
      else delete next.target;
    }
    return { ...collection, steps: collection.steps.map((s, i) => (i === index ? next : s)) };
  });
  deps.recordActivity({ agent: context.agent, tool: "update_step", ok: true, summary: `Changed step ${str(args, "step")} in ${after.name}` });
  return text(`Changed step ${str(args, "step")} in ${after.name}. get_collection shows it.`);
};

const removeStepTool: Tool = async (args, deps, context) => {
  const app = requireApp(deps);
  let dependents: string[] = [];
  const after = changeDraft(app, str(args, "collection"), (collection) => {
    const index = stepIndex(collection, str(args, "step"));
    dependents = dependentsOf(collection, index).map((link) => `${link.targetStep} (${describeLinkTarget(link.target)})`);
    return removeStep(collection, index);
  });
  deps.recordActivity({ agent: context.agent, tool: "remove_step", ok: true, summary: `Removed step ${str(args, "step")} from ${after.name}` });
  return text({
    removed: str(args, "step"),
    collection: after.name,
    ...(dependents.length
      ? { brokenLinks: dependents, note: "These steps used its response and will fail until they get the value elsewhere." }
      : {}),
  });
};

/** `path.orderId`, `query.limit`, `header.X-Request-Id`, `body.items[0].sku`. */
export function parseField(field: string): LinkTarget {
  const match = /^(path|query|headers?|form|body)(?:\.|(?=\[))(.+)$/.exec(field.trim());
  if (!match) throw new Error(`field must look like path.<name>, query.<name>, header.<name> or body.<path>, not "${field}".`);
  const [, where, rest] = match;
  if (where === "body") {
    const path = parseBodyPath(rest);
    if (!path) throw new Error(`"${rest}" isn't a body path. Use dots and [n], such as items[0].sku.`);
    return { in: "body", path };
  }
  return { in: where === "headers" ? "header" : (where as "path" | "query" | "header" | "form"), name: rest };
}

/** `body.id`, `headers.location`, `status`. */
export function parseSource(from: string): PathSegment[] {
  const trimmed = from.trim();
  if (trimmed === "status") return ["status"];
  const header = /^headers?\.(.+)$/.exec(trimmed);
  if (header) return ["headers", header[1].toLowerCase()];
  if (trimmed === "body") return ["body"];
  const body = /^body(?:\.|(?=\[))(.+)$/.exec(trimmed);
  const path = body ? parseBodyPath(body[1]) : null;
  if (!path) throw new Error(`from must look like body.<path>, headers.<name> or status, not "${from}".`);
  return ["body", ...path];
}

const linkValue: Tool = async (args, deps, context) => {
  const app = requireApp(deps);
  const entries = await deps.loadLibrary();
  const specs = await specsFor(entries, deps);
  const field = parseField(str(args, "field") ?? "");
  const sourcePath = parseSource(str(args, "from") ?? "");
  const fromStep = str(args, "from_step");
  const after = changeDraft(app, str(args, "collection"), (collection) => {
    const index = stepIndex(collection, str(args, "step"));
    const sourceIndex = stepIndex(collection, fromStep);
    if (sourceIndex >= index) {
      throw new Error(
        `${fromStep} runs after ${collection.steps[index].key}, so its response isn't there yet. Link from an earlier step, or move the steps.`,
      );
    }
    // A number, flag or object in a JSON body keeps its type: the reference goes in without quotes.
    const link = linkStep(collection.steps[index], collection, entries, specs);
    const bare =
      field.in === "body" && (link.kind === "ok" || link.kind === "stale") ? bareFor(link.spec.doc, link.op, field.path) : false;
    return setLink(collection, index, field, { step: fromStep!, path: sourcePath }, { bare });
  });
  const value = referenceFor(fromStep!, sourcePath);
  deps.recordActivity({
    agent: context.agent,
    tool: "link_value",
    ok: true,
    summary: `In ${after.name}, ${str(args, "step")} now takes ${describeLinkTarget(field)} from ${fromStep}`,
  });
  return text({ collection: after.name, step: str(args, "step"), field: describeLinkTarget(field), value });
};

const setExpectedStatus: Tool = async (args, deps, context) => {
  const app = requireApp(deps);
  const wanted = str(args, "status") ?? "";
  const status = normaliseExpectedStatus(wanted);
  if (!status) throw new Error(`status must be a status such as "201", "404" or "4XX", not "${wanted}".`);
  const after = changeDraft(app, str(args, "collection"), (collection) => {
    const index = stepIndex(collection, str(args, "step"));
    const step = { ...collection.steps[index] };
    if (status === "2XX") delete step.expect;
    else step.expect = { status };
    return { ...collection, steps: collection.steps.map((s, i) => (i === index ? step : s)) };
  });
  deps.recordActivity({ agent: context.agent, tool: "set_expected_status", ok: true, summary: `In ${after.name}, ${str(args, "step")} now expects ${describeExpected(status)}` });
  return text(`${str(args, "step")} now expects ${describeExpected(status)}.`);
};

function stepSummary(result: StepResult, collection: Collection) {
  const step = collection.steps.find((s) => s.key === result.key);
  return {
    step: result.key,
    ...(step?.name ? { name: step.name } : {}),
    result: result.verdict === "not_run" ? "not run" : result.verdict,
    ...(result.status !== undefined ? { status: result.status, ms: result.ms } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.validation?.findings.length
      ? { findings: result.validation.findings.slice(0, 5).map((f) => ({ path: f.path || "(root)", message: f.message })) }
      : {}),
    ...(result.mockWarnings?.length ? { mockWarnings: result.mockWarnings } : {}),
  };
}

const runCollection: Tool = async (args, deps, context) => {
  const app = requireApp(deps);
  const collection = findCollection(app.collections.list(), str(args, "collection"));
  if (!collection.steps.length) return fail(`${collection.name} has no steps to run.`);
  const override = str(args, "target");
  const target = override === "server" ? "first-server" : parseTarget(override);
  const generation = deps.stopGeneration();
  const outcome = await app.collections.run(collection.id, {
    ...(target ? { target } : {}),
    startedBy: context.agent,
    gate: (plan) => deps.gateRequest(context.agent, { method: plan.method, url: plan.url }),
    cancelled: () => deps.stopGeneration() !== generation,
  });
  if ("error" in outcome) return fail(outcome.error);
  const summary = summariseRun(outcome.results);
  deps.recordActivity({ agent: context.agent, tool: "run_collection", ok: summary.failed === 0, summary: `Ran ${collection.name}: ${describeRun(summary)}` });
  return text({
    collection: collection.name,
    runId: outcome.runId,
    summary: describeRun(summary),
    passed: summary.failed === 0 && summary.notRun === 0,
    steps: outcome.results.map((result) => stepSummary(result, collection)),
    note: "The run shows in Studio's Runs view. get_run_log returns its full log.",
  });
};

const getRunLog: Tool = async (args, deps) => {
  const app = requireApp(deps);
  const collection = findCollection(app.collections.list(), str(args, "collection"));
  const runs = app.collections.runLogs(collection.id);
  if (!runs.length) return text(`${collection.name} hasn't been run yet. run_collection runs it.`);
  const wanted = str(args, "run_id");
  const log = wanted ? runs.find((run) => run.id === wanted) : runs[0];
  if (!log) return fail(`No run ${wanted} for ${collection.name}. Its runs: ${runs.map((run) => run.id).join(", ")}.`);
  return text(str(args, "format") === "json" ? runLogJson(log) : runLogText(log));
};

/** An absolute path on macOS, Linux or Windows. */
function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

const saveCollectionToFolder: Tool = async (args, deps, context) => {
  const app = requireApp(deps);
  const collection = findCollection(app.collections.list(), str(args, "collection"));
  const given = str(args, "path");
  if (!given || !isAbsolutePath(given)) throw new Error("Pass path as an absolute path, such as /Users/me/project/tests/checkout.spec0-collection.yaml.");
  const path = withCollectionSuffix(given);
  const existing = await deps.readFile(path);
  const replaces = existing !== null && collection.file?.path !== path;
  const refused = await deps.gateSave(context.agent, collection.name, path, replaces);
  if (refused) return fail(refused);
  const warnings = await app.collections.saveTo(collection.id, path);
  deps.recordActivity({ agent: context.agent, tool: "save_collection_to_folder", ok: true, summary: `Saved ${collection.name} to ${path}` });
  return text({
    collection: collection.name,
    path,
    kept: true,
    ...(warnings.length ? { leftOut: warnings } : {}),
    note: "The collection is linked to this file now. Secret values are written as {{references}}.",
  });
};

// Specs

const reloadSpec: Tool = async (args, deps, context) => {
  const entry = findApi(await deps.loadLibrary(), str(args, "api"));
  let fresh: string | null;
  if (entry.source.kind === "file") {
    fresh = await deps.rereadFile(entry);
    if (fresh === null) return fail(`Couldn't read ${entry.source.ref}. Is it still there?`);
  } else if (entry.source.kind === "url") {
    fresh = await deps.fetchText(entry.source.ref);
  } else {
    return fail(
      entry.source.kind === "spec0"
        ? `${entry.title} comes from Spec0; Studio offers its updates in the library. Ask the user to update it there.`
        : `${entry.title} is the bundled sample, which doesn't change.`,
    );
  }
  const previous = await deps.readSpecText(entry.id);
  if (previous === fresh) return text({ api: entry.title, changed: false, note: "The spec is the same as the one Studio has." });
  let after: ParsedSpec;
  try {
    after = parseSpec(fresh, entry.title, documentUrlOf(entry.source));
  } catch (error) {
    return fail(`The spec doesn't load now, so Studio kept the version it had: ${error instanceof Error ? error.message : String(error)}. validate_spec says more.`);
  }
  let before: ParsedSpec | null = null;
  try {
    before = previous ? parseSpec(previous, entry.title, documentUrlOf(entry.source)) : null;
  } catch {
    before = null;
  }
  await deps.applyUpdate(entry.id, { text: fresh, title: after.title, version: after.version, operations: after.operations.length, schemas: after.schemas.length });
  deps.specChanged(entry.id);
  const changes = before ? specChanges(before, after) : null;
  deps.recordActivity({ agent: context.agent, tool: "reload_spec", ok: true, summary: `Reloaded ${entry.title}` });
  return text({
    api: entry.title,
    changed: true,
    version: after.version,
    ...(changes
      ? noChanges(changes)
        ? { note: "The text changed, but no operation, schema, server or version did." }
        : { changes }
      : { note: "The previous version couldn't be read, so there is nothing to compare." }),
  });
};

const validateSpec: Tool = async (args, deps) => {
  const entry = findApi(await deps.loadLibrary(), str(args, "api"));
  const document = await deps.readSpecText(entry.id);
  if (!document) return fail(`Studio has no document stored for ${entry.title}.`);
  const problems = specProblems(document, entry.title, documentUrlOf(entry.source));
  const errors = problems.filter((problem) => problem.level === "error").length;
  return text({
    api: entry.title,
    summary: problems.length
      ? `${errors} error${errors === 1 ? "" : "s"}, ${problems.length - errors} warning${problems.length - errors === 1 ? "" : "s"}`
      : "No problems found.",
    problems,
    note: "This checks the version Studio has. After changing the file, call reload_spec first.",
  });
};

/** Every tool in this module, by name. */
export const AGENT_TOOLS: Record<string, Tool> = {
  send_request: sendRequest,
  check_contract: checkContract,
  list_local_mocks: listLocalMocks,
  start_local_mock: startLocalMock,
  stop_local_mock: stopLocalMock,
  list_collections: listCollections,
  get_collection: getCollection,
  create_collection: createCollection,
  add_step: addStep,
  update_step: updateStep,
  remove_step: removeStepTool,
  link_value: linkValue,
  set_expected_status: setExpectedStatus,
  run_collection: runCollection,
  get_run_log: getRunLog,
  save_collection_to_folder: saveCollectionToFolder,
  reload_spec: reloadSpec,
  validate_spec: validateSpec,
};

/** Run one of these tools. Never throws: every failure is a result the agent can read. */
export async function runAgentTool(name: string, args: unknown, deps: AgentToolDeps, context: ToolContext): Promise<ToolResult> {
  const tool = AGENT_TOOLS[name];
  if (!tool) return fail(`Studio doesn't answer ${name} here.`);
  const input = args && typeof args === "object" && !Array.isArray(args) ? (args as Json) : {};
  try {
    return await tool(input, deps, context);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

// For link_value's body fields: whether the field holds a non-string, so the
// reference is written without quotes and the value keeps its type.
export function bareFor(doc: Json | null, op: OperationSpec | null, path: PathSegment[]): boolean {
  if (!doc || !op?.requestBody?.schema) return false;
  const type = schemaTypeAt(doc, op.requestBody.schema, path);
  return Boolean(type) && type !== "string";
}
