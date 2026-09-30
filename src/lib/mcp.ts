import toolDefinitions from "./mcp-tools.json";
import { documentUrlOf, type LibraryEntry } from "./library";
import { deriveApiName } from "./publish";
import { parseSpec, resolveRef, resolveServers, type Json, type OperationSpec, type ParsedSpec } from "./spec";
import {
  absoluteMockUrl,
  apiIdFromRef,
  DEFAULT_API_URL,
  DEFAULT_APP_URL,
  describeBody,
  MOCK_KEY_HEADER,
  Spec0Error,
  type CreatedMock,
  type MockKey,
  type MockServer,
  type RefreshedMock,
  type Session,
  type TeamApi,
} from "./spec0";
import { describeMockRefresh } from "./sync";

/**
 * The tools of Studio's local MCP server.
 *
 * The server itself is Rust (`src-tauri/src/mcp.rs`): it owns the socket, the
 * token and origin checks, and the protocol. It hands each tool call to the web
 * view, and this module answers it, because this is where Studio already
 * parses specs and talks to Spec0. `list_environments` is the exception, and is
 * answered in Rust so secret values never pass through here at all.
 *
 * Everything is read from what Studio has stored, never from React state, so
 * an answer is the same whichever screen is open. Nothing here sends a request
 * to an API: agents get URLs and call them themselves. The signed-in tools talk
 * to Spec0, and only when an agent calls them.
 */

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  requiresSignIn: boolean;
}

/** The same list the Rust server returns from `tools/list`. */
export const MCP_TOOLS: ToolDefinition[] = toolDefinitions.map((tool) => ({
  name: tool.name,
  title: tool.title,
  description: tool.description,
  requiresSignIn: tool.requiresSignIn,
}));

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** What the tools read and do. Injected so they can be tested without Tauri. */
export interface ToolDeps {
  loadLibrary: () => Promise<LibraryEntry[]>;
  readSpecText: (id: string) => Promise<string | null>;
  loadSession: () => Promise<Session | null>;
  studioVersion: () => Promise<string | null>;
  listTeamApis: (session: Session) => Promise<TeamApi[]>;
  listMocks: (session: Session) => Promise<MockServer[]>;
  createMock: (session: Session, apiId: string) => Promise<CreatedMock>;
  refreshMock: (session: Session, mockServerId: string) => Promise<RefreshedMock>;
  /** A mock's key from Spec0, or null when it won't say (404, older platform). */
  getMockApiKey: (session: Session, mockServerId: string) => Promise<MockKey | null>;
  setMock: (
    id: string,
    mock: {
      mockUrl?: string | null;
      mockApiKey?: string | null;
      mockServerId?: string | null;
      mockSpecVersion?: string | null;
      clearStale?: boolean;
    },
  ) => Promise<unknown>;
  /** The library file changed underneath the interface; tell it to reload. */
  libraryChanged: () => void;
}

/** How much of a spec one `get_api_spec` call returns. */
export const SPEC_PAGE_CHARS = 50_000;
/** Above this, schemas in `get_operation` are expanded less deeply. */
const OPERATION_CHARS = 60_000;

export const SIGN_IN_MESSAGE =
  "Sign in to Spec0 in Studio to use this: ask the user to sign in there, then try again. Everything else on this server works without an account.";

// Results

function text(value: unknown): ToolResult {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

class ToolFailure extends Error {}

function str(args: Json, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function int(args: Json, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined;
}

// Finding things

/** An API by id, then exact title, then a title that uniquely contains the text. */
export function findApi(entries: LibraryEntry[], ref: string | undefined): LibraryEntry {
  if (!ref) throw new ToolFailure("Say which API: pass `api` with an id or title from list_local_apis.");
  const byId = entries.find((entry) => entry.id === ref);
  if (byId) return byId;
  const lowered = ref.toLowerCase();
  const exact = entries.filter((entry) => entry.title.toLowerCase() === lowered);
  if (exact.length === 1) return exact[0];
  const partial = exact.length ? exact : entries.filter((entry) => entry.title.toLowerCase().includes(lowered));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new ToolFailure(
      `More than one API matches "${ref}": ${partial.map((entry) => `${entry.title} (id ${entry.id})`).join(", ")}. Pass the id.`,
    );
  }
  throw new ToolFailure(`No API called "${ref}" in Studio. Call list_local_apis to see what's there.`);
}

const parsedCache = new Map<string, { text: string; spec: ParsedSpec }>();

async function specFor(entry: LibraryEntry, deps: ToolDeps): Promise<ParsedSpec> {
  const text = await deps.readSpecText(entry.id);
  if (!text) throw new ToolFailure(`Studio has no document stored for ${entry.title}.`);
  const cached = parsedCache.get(entry.id);
  if (cached && cached.text === text) return cached.spec;
  const spec = parseSpec(text, entry.title, documentUrlOf(entry.source));
  parsedCache.set(entry.id, { text, spec });
  return spec;
}

/**
 * The spec's server URLs, ready to use: `{variables}` filled with their
 * declared defaults, and relative URLs resolved against where the document came from.
 */
export function serverUrls(doc: Json, documentUrl?: string): string[] {
  const servers: Json[] = Array.isArray(doc.servers) ? doc.servers : [];
  const urls = servers
    .filter((server) => server && typeof server.url === "string")
    .map((server) =>
      server.url.replace(/\{([^}]+)\}/g, (whole: string, name: string) => {
        const fallback = server.variables?.[name]?.default;
        return fallback === undefined ? whole : String(fallback);
      }),
    );
  return resolveServers(urls, documentUrl).map((url) => url.replace(/\/+$/, ""));
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

/** `/orders/{id}` matches `/orders/{orderId}` and `/orders/42`. */
function pathMatches(template: string, path: string): boolean {
  if (template === path) return true;
  const pattern = template
    .split(/\{[^}]+\}/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]+");
  return new RegExp(`^${pattern}/?$`).test(path);
}

export function findOperation(
  operations: OperationSpec[],
  selector: { operationId?: string; method?: string; path?: string },
): OperationSpec | null {
  if (selector.operationId) {
    const wanted = selector.operationId;
    return (
      operations.find((op) => op.operationId === wanted) ??
      operations.find((op) => op.operationId?.toLowerCase() === wanted.toLowerCase()) ??
      null
    );
  }
  if (selector.method && selector.path) {
    const method = selector.method.toUpperCase();
    const candidates = operations.filter((op) => op.method === method);
    return (
      candidates.find((op) => op.path === selector.path) ??
      candidates.find((op) => pathMatches(op.path, selector.path!)) ??
      null
    );
  }
  return null;
}

/**
 * A schema with its `$ref`s filled in, down to a depth.
 *
 * Never the whole document: a reference already expanded on this path comes
 * back as `{ $ref, circular: true }`, and one past the depth limit stays a bare
 * `$ref`, so self-referencing schemas and very large specs both stay finite.
 */
export function expandSchema(doc: Json, node: unknown, maxDepth: number, seen: string[] = []): unknown {
  if (Array.isArray(node)) return node.map((item) => expandSchema(doc, item, maxDepth, seen));
  if (!node || typeof node !== "object") return node;
  const object = node as Json;
  if (typeof object.$ref === "string") {
    const ref = object.$ref;
    if (seen.includes(ref)) return { $ref: ref, circular: true };
    if (seen.length >= maxDepth) return { $ref: ref };
    const target = resolveRef(doc, ref);
    if (target === undefined) return { $ref: ref, unresolved: true };
    const expanded = expandSchema(doc, target, maxDepth, [...seen, ref]);
    const name = ref.split("/").pop();
    return expanded && typeof expanded === "object" && !Array.isArray(expanded) && name
      ? { "x-schema-name": name, ...(expanded as Json) }
      : expanded;
  }
  const out: Json = {};
  for (const [key, value] of Object.entries(object)) out[key] = expandSchema(doc, value, maxDepth, seen);
  return out;
}

// Search

function words(value: string | undefined): string {
  return (value ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase();
}

function tokens(query: string): string[] {
  return words(query)
    .split(/[^a-z0-9{}]+/)
    .map((token) => token.replace(/[{}]/g, ""))
    .filter((token) => token.length > 0);
}

/** "orders" finds "order", "categories" finds "category". */
function stem(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return token.slice(0, -3);
  if (token.length > 3 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

function isSubsequence(needle: string, haystack: string): boolean {
  let index = 0;
  for (const char of haystack) {
    if (char === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return false;
}

/** How well an operation matches a query; 0 means it doesn't. */
export function scoreOperation(op: OperationSpec, query: string): number {
  const terms = tokens(query);
  if (!terms.length) return 0;
  const fields: Array<[string, number]> = [
    [words(op.path), 3],
    [words(op.operationId), 3],
    [words(op.summary), 2],
    [words(op.tag), 1.5],
    [op.method.toLowerCase(), 1],
    [words(op.description), 0.5],
  ];
  let score = 0;
  let matched = 0;
  for (const term of terms) {
    const root = stem(term);
    let best = 0;
    for (const [field, weight] of fields) {
      if (field.includes(root)) best = Math.max(best, weight);
    }
    if (!best && root.length >= 3) {
      const compact = `${op.path}${op.operationId ?? ""}`.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (isSubsequence(root, compact)) best = 0.4;
    }
    if (best) matched += 1;
    score += best;
  }
  if (matched < Math.ceil(terms.length / 2)) return 0;
  const whole = query.trim().toLowerCase();
  if (whole.length > 2 && (op.path.toLowerCase().includes(whole) || (op.summary ?? "").toLowerCase().includes(whole))) {
    score += 3;
  }
  return Math.round(score * (matched / terms.length) * 100) / 100;
}

// Tools

type Tool = (args: Json, deps: ToolDeps) => Promise<ToolResult>;

const listLocalApis: Tool = async (_args, deps) => {
  const entries = await deps.loadLibrary();
  const apis = await Promise.all(
    entries.map(async (entry) => {
      let baseUrls: string[] = [];
      let problem: string | undefined;
      try {
        const spec = await specFor(entry, deps);
        baseUrls = serverUrls(spec.doc, documentUrlOf(entry.source));
      } catch (error) {
        problem = error instanceof Error ? error.message : String(error);
      }
      return {
        id: entry.id,
        title: entry.title,
        version: entry.version,
        source: { kind: entry.source.kind, location: entry.source.ref },
        operations: entry.operations,
        baseUrls,
        hasMock: Boolean(entry.mockUrl || entry.mockServerId),
        ...(entry.environments?.length
          ? { spec0Environments: entry.environments.map((env) => ({ name: env.name, url: env.url })) }
          : {}),
        ...(problem ? { problem } : {}),
      };
    }),
  );
  return text({
    count: apis.length,
    apis,
    ...(apis.length
      ? {}
      : { note: "Studio's library is empty. The user can open a spec from a file, a URL or Spec0." }),
  });
};

const getApiSpec: Tool = async (args, deps) => {
  const entry = findApi(await deps.loadLibrary(), str(args, "api"));
  const document = await deps.readSpecText(entry.id);
  if (!document) throw new ToolFailure(`Studio has no document stored for ${entry.title}.`);
  const offset = Math.max(0, int(args, "offset") ?? 0);
  if (offset >= document.length && document.length > 0) {
    throw new ToolFailure(`offset ${offset} is past the end; the document has ${document.length} characters.`);
  }
  const end = Math.min(document.length, offset + SPEC_PAGE_CHARS);
  const complete = offset === 0 && end === document.length;
  const header = complete
    ? `OpenAPI document for ${entry.title} ${entry.version} (id ${entry.id}), ${document.length} characters, complete.`
    : `OpenAPI document for ${entry.title} ${entry.version} (id ${entry.id}): characters ${offset}–${end} of ${document.length}.` +
      (end < document.length
        ? ` Call get_api_spec again with offset=${end} for the next part, or use get_operation for a single endpoint.`
        : " This is the last part.");
  return {
    content: [
      { type: "text", text: header },
      { type: "text", text: document.slice(offset, end) },
    ],
  };
};

const getOperation: Tool = async (args, deps) => {
  const entry = findApi(await deps.loadLibrary(), str(args, "api"));
  const spec = await specFor(entry, deps);
  const selector = { operationId: str(args, "operation_id"), method: str(args, "method"), path: str(args, "path") };
  if (!selector.operationId && !(selector.method && selector.path)) {
    throw new ToolFailure("Pass operation_id, or both method and path.");
  }
  const op = findOperation(spec.operations, selector);
  if (!op) {
    const query = selector.operationId ?? `${selector.method} ${selector.path}`;
    const near = spec.operations
      .map((candidate) => ({ candidate, score: scoreOperation(candidate, query) }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(({ candidate }) => `${candidate.method} ${candidate.path}${candidate.operationId ? ` (${candidate.operationId})` : ""}`);
    throw new ToolFailure(
      `No operation ${query} in ${entry.title}.` + (near.length ? ` Close matches: ${near.join("; ")}.` : ""),
    );
  }

  const servers = serverUrls(spec.doc, documentUrlOf(entry.source));
  const rawOp: Json = spec.doc.paths?.[op.path]?.[op.method.toLowerCase()] ?? {};
  const bodyContentTypes = Object.keys(
    (resolveRef(spec.doc, rawOp.requestBody?.$ref ?? "") ?? rawOp.requestBody)?.content ?? {},
  );
  const schemes = new Set(op.security ?? []);

  const build = (depth: number) => ({
    api: { id: entry.id, title: entry.title, version: entry.version },
    method: op.method,
    path: op.path,
    operationId: op.operationId,
    summary: op.summary,
    description: op.description,
    tag: op.tag,
    deprecated: op.deprecated || undefined,
    urls: servers.length
      ? servers.map((server) => ({ server, url: joinUrl(server, op.path) }))
      : [{ server: null, url: op.path, note: "The spec declares no servers; ask the user where this API runs." }],
    ...(entry.mockUrl ? { mockUrl: joinUrl(entry.mockUrl, op.path) } : {}),
    parameters: op.parameters.map((param) => ({
      name: param.name,
      in: param.in,
      required: param.required,
      description: param.description,
      schema: expandSchema(spec.doc, param.schema, depth),
    })),
    requestBody: op.requestBody
      ? {
          required: op.requestBody.required,
          contentType: op.requestBody.contentType,
          ...(bodyContentTypes.length > 1 ? { otherContentTypes: bodyContentTypes.filter((type) => type !== op.requestBody!.contentType) } : {}),
          schema: expandSchema(spec.doc, op.requestBody.schema, depth),
        }
      : undefined,
    responses: op.responses.map((response) => ({
      status: response.status,
      description: response.description,
      contentType: response.contentType,
      schema: expandSchema(spec.doc, response.schema, depth),
    })),
    security: spec.securitySchemes
      .filter((scheme) => schemes.has(scheme.name))
      .map((scheme) => ({
        name: scheme.name,
        type: scheme.type,
        scheme: scheme.scheme,
        in: scheme.in,
        parameterName: scheme.paramName,
        description: scheme.description,
      })),
    note:
      "Studio doesn't send requests for you. Fill in {path} parameters and call the URL yourself, for example with curl. " +
      (entry.mockUrl ? "For the hosted mock's key, call get_mock_server. " : "") +
      "Credentials the user keeps in Studio as secrets aren't shared; ask the user if you need one.",
  });

  let result = JSON.stringify(build(4), null, 2);
  for (const depth of [2, 1, 0]) {
    if (result.length <= OPERATION_CHARS) break;
    result = JSON.stringify(build(depth), null, 2);
  }
  return text(result);
};

const searchOperations: Tool = async (args, deps) => {
  const query = str(args, "query");
  if (!query) throw new ToolFailure("Pass a query.");
  const limit = Math.min(50, Math.max(1, int(args, "limit") ?? 15));
  const entries = await deps.loadLibrary();
  const scope = str(args, "api") ? [findApi(entries, str(args, "api"))] : entries;

  const matches: Array<Json & { score: number }> = [];
  for (const entry of scope) {
    let spec: ParsedSpec;
    try {
      spec = await specFor(entry, deps);
    } catch {
      continue; // one unreadable spec shouldn't hide matches in the others
    }
    for (const op of spec.operations) {
      const score = scoreOperation(op, query);
      if (score > 0) {
        matches.push({
          score,
          api: entry.title,
          apiId: entry.id,
          method: op.method,
          path: op.path,
          operationId: op.operationId,
          summary: op.summary,
        });
      }
    }
  }
  matches.sort((a, b) => b.score - a.score);
  return text({
    query,
    results: matches.slice(0, limit),
    ...(matches.length
      ? {}
      : { note: "Nothing in Studio's library matches. To search every API in the organisation, use the remote Spec0 MCP server." }),
  });
};

const getConnectionStatus: Tool = async (_args, deps) => {
  const [session, version, entries] = await Promise.all([
    deps.loadSession(),
    deps.studioVersion(),
    deps.loadLibrary(),
  ]);
  const apiUrl = (session?.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
  return text({
    mode: session ? "signed-in" : "local",
    organisation: session?.orgName ?? null,
    spec0AppUrl: session?.appUrl ?? DEFAULT_APP_URL,
    remoteSpec0McpServer: `${apiUrl}/mcp`,
    studioVersion: version,
    mcpServer: { name: "spec0-studio", version },
    apisInLibrary: entries.length,
    signedInToolsAvailable: Boolean(session),
    note: session
      ? "Signed in: the mock server tools work. For the organisation's whole API catalogue, use the remote Spec0 MCP server."
      : "Working locally: every tool works except the mock server ones, which need the user to sign in to Spec0 in Studio.",
  });
};

// Signed-in tools

async function requireSession(deps: ToolDeps): Promise<Session> {
  const session = await deps.loadSession();
  if (!session) throw new NotSignedIn();
  return session;
}

class NotSignedIn extends Error {}

/** The Spec0 API behind a library entry, or null when it isn't published. */
async function publishedApi(
  entry: LibraryEntry,
  session: Session,
  deps: ToolDeps,
): Promise<{ apiId: string; apiName?: string; matchedByName: boolean } | null> {
  if (entry.source.kind === "spec0") {
    const apiId = apiIdFromRef(entry.source.ref);
    return apiId ? { apiId, matchedByName: false } : null;
  }
  // Published from Studio: the link was recorded then.
  if (entry.spec0ApiId) return { apiId: entry.spec0ApiId, matchedByName: false };
  // A spec published from a file keeps its file source; match it by the name
  // Studio suggests when publishing it.
  const name = deriveApiName(entry.title);
  if (!name) return null;
  const apis = await deps.listTeamApis(session);
  const match = apis.find((api) => api.apiName === name);
  return match ? { apiId: match.apiId, apiName: match.apiName, matchedByName: true } : null;
}

function notPublished(entry: LibraryEntry): string {
  const how =
    entry.source.kind === "file" || entry.source.kind === "url"
      ? "The user can publish it from Studio: open the API and choose Create mock, or Publish."
      : "This is the bundled sample, which isn't a real API and can't be published.";
  return `${entry.title} isn't published to Spec0 yet, so it has no hosted mock. ${how}`;
}

function curlExample(mockUrl: string, key: string | undefined, operations: OperationSpec[]): string {
  const op =
    operations.find((candidate) => candidate.method === "GET" && !candidate.path.includes("{")) ??
    operations.find((candidate) => candidate.method === "GET") ??
    operations[0];
  const url = joinUrl(mockUrl, op?.path ?? "/");
  const method = op && op.method !== "GET" ? `-X ${op.method} ` : "";
  return `curl --globoff ${method}-H '${MOCK_KEY_HEADER}: ${key ?? "<mock API key>"}' '${url}'`;
}

async function operationsOf(entry: LibraryEntry, deps: ToolDeps): Promise<OperationSpec[]> {
  try {
    return (await specFor(entry, deps)).operations;
  } catch {
    return [];
  }
}

const NO_KEY_NOTE =
  "Studio doesn't have this mock's key and Spec0 didn't return it. The user can copy it from the Spec0 dashboard and paste it into Studio, which asks for it when a request is pointed at the mock.";

/**
 * Ask Spec0 for a key Studio doesn't have, and keep it. Null when Spec0 won't
 * give it (404 or unreachable); the caller then falls back to the note above.
 */
async function fetchMissingKey(
  entry: LibraryEntry,
  mockServerId: string | undefined,
  session: Session,
  deps: ToolDeps,
): Promise<string | undefined> {
  if (!mockServerId) return undefined;
  const found = await deps.getMockApiKey(session, mockServerId).catch(() => null);
  if (!found) return undefined;
  await deps.setMock(entry.id, { mockApiKey: found.apiKey, mockServerId });
  deps.libraryChanged();
  return found.apiKey;
}

const getMockServer: Tool = async (args, deps) => {
  const entry = findApi(await deps.loadLibrary(), str(args, "api"));
  const session = await requireSession(deps);

  let mock: MockServer | undefined;
  try {
    const mocks = await deps.listMocks(session);
    const published = entry.mockServerId ? null : await publishedApi(entry, session, deps).catch(() => null);
    mock =
      mocks.find((row) => entry.mockServerId && row.mockServerId === entry.mockServerId) ??
      mocks.find((row) => published && row.apiId === published.apiId);
  } catch {
    // Offline or refused: fall back to what Studio stored.
  }

  const mockUrl = absoluteMockUrl(session.apiUrl, mock?.mockBaseUrl) ?? entry.mockUrl ?? null;
  if (!mockUrl) {
    return text(
      `${entry.title} has no hosted mock. Create one with create_mock_server (the API has to be published to Spec0).`,
    );
  }
  const key =
    entry.mockApiKey ??
    (await fetchMissingKey(entry, entry.mockServerId ?? mock?.mockServerId, session, deps));
  const specVersion = mock?.specVersion ?? entry.mockSpecVersion ?? null;
  return text({
    api: { id: entry.id, title: entry.title, versionInStudio: entry.version },
    mockUrl,
    apiKey: key ?? null,
    authentication: { header: MOCK_KEY_HEADER, value: key ?? null },
    mockSpecVersion: specVersion,
    ...(specVersion && entry.version && specVersion !== entry.version
      ? { versionNote: `The mock serves ${specVersion}; Studio holds ${entry.version}. refresh_mock_server rebuilds it from the latest published version.` }
      : {}),
    curl: curlExample(mockUrl, key, await operationsOf(entry, deps)),
    ...(key ? {} : { note: NO_KEY_NOTE }),
  });
};

const createMockServer: Tool = async (args, deps) => {
  const entry = findApi(await deps.loadLibrary(), str(args, "api"));
  const session = await requireSession(deps);
  const published = await publishedApi(entry, session, deps);
  if (!published) return text(notPublished(entry));

  let created: CreatedMock;
  try {
    created = await deps.createMock(session, published.apiId);
  } catch (error) {
    if (error instanceof Spec0Error && error.status > 0) {
      // The server's own words, not ours.
      const said = describeBody(error.body);
      return fail(`Spec0 couldn't create the mock (HTTP ${error.status}).${said ? ` It said: ${said}` : ""}`);
    }
    throw error;
  }

  await deps.setMock(entry.id, {
    mockUrl: created.mockUrl,
    mockApiKey: created.apiKey ?? null,
    mockServerId: created.mockServerId ?? null,
  });
  deps.libraryChanged();

  const key =
    created.apiKey ??
    entry.mockApiKey ??
    (await fetchMissingKey(entry, created.mockServerId, session, deps));
  return text({
    api: { id: entry.id, title: entry.title },
    ...(published.matchedByName ? { spec0Api: published.apiName } : {}),
    created: created.created !== false,
    mockUrl: created.mockUrl,
    apiKey: key ?? null,
    authentication: { header: MOCK_KEY_HEADER, value: key ?? null },
    ...(created.mockUrl ? { curl: curlExample(created.mockUrl, key, await operationsOf(entry, deps)) } : {}),
    ...(key
      ? { note: "Studio saved the mock and its key; get_mock_server returns them later." }
      : { note: NO_KEY_NOTE }),
  });
};

const refreshMockServer: Tool = async (args, deps) => {
  const entry = findApi(await deps.loadLibrary(), str(args, "api"));
  const session = await requireSession(deps);

  let mockServerId = entry.mockServerId;
  if (!mockServerId) {
    const published = await publishedApi(entry, session, deps);
    if (!published) return text(notPublished(entry));
    const mocks = await deps.listMocks(session);
    mockServerId = mocks.find((row) => row.apiId === published.apiId)?.mockServerId;
  }
  if (!mockServerId) return text(`${entry.title} has no hosted mock to rebuild. create_mock_server makes one.`);

  let result: RefreshedMock;
  try {
    result = await deps.refreshMock(session, mockServerId);
  } catch (error) {
    if (error instanceof Spec0Error && error.status > 0) return fail(error.message);
    throw error;
  }
  await deps.setMock(entry.id, {
    mockServerId,
    mockSpecVersion: result.specVersion ?? entry.version,
    clearStale: true,
  });
  deps.libraryChanged();
  return text({
    api: { id: entry.id, title: entry.title },
    refreshed: Boolean(result.refreshed),
    specVersion: result.specVersion ?? null,
    summary: describeMockRefresh(result),
  });
};

const TOOLS: Record<string, Tool> = {
  list_local_apis: listLocalApis,
  get_api_spec: getApiSpec,
  get_operation: getOperation,
  search_operations: searchOperations,
  get_connection_status: getConnectionStatus,
  get_mock_server: getMockServer,
  create_mock_server: createMockServer,
  refresh_mock_server: refreshMockServer,
};

/** Run one tool. Never throws: every failure is a result the agent can read. */
export async function runTool(name: string, args: unknown, deps: ToolDeps): Promise<ToolResult> {
  const tool = TOOLS[name];
  if (!tool) return fail(`Studio doesn't answer ${name} here.`);
  const input = args && typeof args === "object" && !Array.isArray(args) ? (args as Json) : {};
  try {
    return await tool(input, deps);
  } catch (error) {
    if (error instanceof NotSignedIn) return fail(SIGN_IN_MESSAGE);
    return fail(error instanceof Error ? error.message : String(error));
  }
}
