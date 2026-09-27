import { appFetch } from "./request";
import {
  awaitOAuthCallback,
  openInBrowser,
  readCliSession,
  readStore,
  writeStore,
  STORE,
} from "./store";

/**
 * spec0 cloud module.
 *
 * Everything here targets the **public V1 surface** the CLI already uses
 * (`/api/v1/public/**`, `Authorization: Bearer <token>` + `X-Org-Id`), so Studio
 * uses only spec0's public API, the same one the spec0 CLI uses.
 *
 * Sign-in reuses the CLI's flow verbatim: open `{appUrl}/cli-auth` with a
 * loopback `redirect_uri` and wait for `token` / `org` / `org_name` to come back.
 * If the user already ran `spec0 auth login`, we adopt that session instead and
 * they never see a browser at all.
 *
 * Every API in the org opens by UUID; nothing here needs an org slug.
 */

export const DEFAULT_API_URL = "https://api.spec0.io";
export const DEFAULT_APP_URL = "https://app.spec0.io";

/**
 * Every API in the org is fetched by UUID through
 * `GET /api/v1/public/apis/team/{apiId}/spec`, which the platform spec describes as
 * resolving private APIs "without a public org slug". That matters: the registry
 * route needs `{orgSlug}` and **no endpoint returns one** — not the API list, not
 * the org summary — so anything built on it needs the user to type a slug by hand.
 * Resolving by UUID sidesteps that entirely.
 *
 * When checking what the API offers, read the published spec, not a generated
 * client: a generated client can lag behind it.
 */

export interface Session {
  apiUrl: string;
  appUrl: string;
  orgId: string;
  orgName: string;
  /** Registry path segment. Guessed from the org name, correctable — see `slugify`. */
  orgSlug?: string;
  token: string;
  /** How we got here — shown in settings so the user knows what to revoke. */
  source: "cli" | "browser" | "manual";
  connectedAt: string;
}

export interface TeamApi {
  apiId: string;
  apiName: string;
  version?: string | null;
  description?: string | null;
  teamName?: string | null;
  updatedAt?: string | null;
}

export interface MockServer {
  mockServerId?: string;
  apiId?: string;
  apiName?: string;
  name?: string;
  mockBaseUrl?: string;
  /**
   * The spec version the mock actually serves.
   *
   * Absent on platforms that predate the field, in which case staleness falls back
   * to comparing timestamps — a heuristic, and the reason this exists.
   */
  specVersion?: string | null;
}

export interface RegistryEntry {
  apiSlug: string;
  title: string;
  version?: string | null;
  description?: string | null;
  visibility?: string | null;
}

/** One row of the org catalog: an API you can open, however it's published. */
export interface CatalogEntry {
  apiId: string;
  apiName: string;
  version?: string | null;
  description?: string | null;
  teamName?: string | null;
  /** Also published to the public registry. */
  isPublic: boolean;
  mockServerId: string | null;
  /** Absolute — see `absoluteMockUrl`. */
  mockUrl: string | null;
  /** The spec version the mock serves, when the platform reports it. */
  mockSpecVersion: string | null;
}

/** The header the mock server authenticates with. */
export const MOCK_KEY_HEADER = "X-Mock-API-Key";

/**
 * `mockBaseUrl` comes back host-relative (`/mock/…`), which is useless as a request
 * target — resolve it against the API base so what lands in the address bar is
 * something you could paste into curl.
 */
export function absoluteMockUrl(apiUrl: string, mockBaseUrl: string | undefined): string | null {
  if (!mockBaseUrl) return null;
  if (/^https?:\/\//i.test(mockBaseUrl)) return mockBaseUrl;
  try {
    return new URL(mockBaseUrl, apiUrl.replace(/\/$/, "") + "/").toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

/**
 * The registry route is `/registry/{orgSlug}/{apiName}`, but **no endpoint on the
 * public surface returns the org slug** — not the API list, not the org summary.
 * The CLI sidesteps this because the user types `spec0 pull <org>/<name>` and
 * supplies it directly.
 *
 * So Studio guesses from the org name and lets the user correct it once, storing
 * the answer on the session. Slugifying a display name is a heuristic, not a
 * derivation; the UI says so rather than failing mysteriously.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ── Session ────────────────────────────────────────────────────────────────────

export async function loadSession(): Promise<Session | null> {
  return readStore<Session | null>(STORE.session, null);
}

export async function saveSession(session: Session | null): Promise<void> {
  await writeStore(STORE.session, session);
}

/** Sign out. Nothing local is lost — the client reverts to purely local operation. */
export async function signOut(): Promise<void> {
  await writeStore(STORE.session, null);
}

/** Adopt an existing `spec0 auth login` session, so CLI users connect with one click. */
export async function adoptCliSession(): Promise<Session | null> {
  const found = await readCliSession();
  if (!found) return null;
  return {
    apiUrl: found.config.apiUrl || DEFAULT_API_URL,
    appUrl: DEFAULT_APP_URL,
    orgId: found.orgId,
    orgName: found.config.orgName ?? "your org",
    orgSlug: slugify(found.config.orgName ?? ""),
    token: found.config.apiKey!,
    source: "cli",
    connectedAt: new Date().toISOString(),
  };
}

/** Raised when the user pressed Cancel on the sign-in page. Not an error to show as one. */
export class SignInCancelled extends Error {
  constructor() {
    super("Sign-in cancelled");
    this.name = "SignInCancelled";
  }
}

/**
 * A fresh `state` value for one sign-in attempt: 32 random bytes from the
 * platform's cryptographic generator, hex-encoded. `Math.random` is not good
 * enough here — the value is what stops another page from completing a sign-in
 * the user never started.
 */
export function newSignInState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** What came back to the loopback listener, decided. */
export type SignInOutcome =
  | { kind: "ok"; token: string; orgId: string; orgName: string | null }
  | { kind: "cancelled" }
  | { kind: "error"; message: string };

/**
 * Decide what a sign-in callback means. Pure, so every branch is tested.
 *
 * - `state` present and different from the one we sent: rejected, nothing is kept.
 * - `state` absent: accepted. Older sign-in pages don't send it back yet, and
 *   refusing those would lock people out of a flow that works today.
 * - `error=access_denied`: the user pressed Cancel. Reported as cancelled, not failed.
 */
export function readSignInCallback(
  params: Record<string, string>,
  expectedState: string,
): SignInOutcome {
  if (params.state !== undefined && params.state !== expectedState) {
    return {
      kind: "error",
      message: "The sign-in response didn't match this request, so it was ignored. Please try again.",
    };
  }
  if (params.error === "access_denied") return { kind: "cancelled" };
  if (params.error) {
    const detail = params.error_description?.trim();
    return { kind: "error", message: `Sign-in failed: ${detail || params.error}` };
  }
  if (!params.token || !params.org) {
    return { kind: "error", message: "Sign-in didn't return a token. Please try again." };
  }
  return { kind: "ok", token: params.token, orgId: params.org, orgName: params.org_name || null };
}

/**
 * Browser sign-in: the CLI's loopback flow, with the listener held in Rust.
 *
 * Sent with `client=studio` so Studio gets a token of its own and signing in
 * here doesn't sign the CLI out.
 */
export async function signInViaBrowser(
  appUrl = DEFAULT_APP_URL,
  apiUrl = DEFAULT_API_URL,
): Promise<Session> {
  // Same port range the CLI uses, so a firewall prompt the user already accepted carries over.
  const port = 38473 + Math.floor(Math.random() * 1000);
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const state = newSignInState();

  const authUrl = new URL("/cli-auth", appUrl);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("client", "studio");

  // Start listening before the browser opens, or a fast redirect races the bind.
  const pending = awaitOAuthCallback(port, 120, state);
  await openInBrowser(authUrl.toString());

  const outcome = readSignInCallback(await pending, state);
  if (outcome.kind === "cancelled") throw new SignInCancelled();
  if (outcome.kind === "error") throw new Error(outcome.message);

  return {
    apiUrl,
    appUrl,
    orgId: outcome.orgId,
    orgName: outcome.orgName || "your org",
    orgSlug: slugify(outcome.orgName || ""),
    token: outcome.token,
    source: "browser",
    connectedAt: new Date().toISOString(),
  };
}

// ── API ────────────────────────────────────────────────────────────────────────

function headers(session: Session): Record<string, string> {
  return {
    Authorization: `Bearer ${session.token}`,
    "X-Org-Id": session.orgId,
    Accept: "application/json",
  };
}

/**
 * A failed platform call, with enough detail to act on.
 *
 * The first version of this collapsed everything into "spec0 rejected the token —
 * sign in again", which is unfalsifiable: it looks identical whether the token is
 * bad, the org header is wrong, the base URL points somewhere that doesn't serve
 * this route, or the backend returned a Problem document explaining exactly what
 * was wrong. The CLI gets this right — it reports the URL and the HTTP status —
 * and so should this.
 */
export class Spec0Error extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(message);
    this.name = "Spec0Error";
  }
}

/** Pull a human message out of a Problem/JSON error body, if there is one. */
export function describeBody(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const message =
      parsed.detail ?? parsed.message ?? parsed.title ?? parsed.error ?? parsed.error_description;
    if (typeof message === "string" && message.trim()) return message.trim();
  } catch {
    /* not JSON — fall through to the raw text */
  }
  return trimmed.slice(0, 300);
}

async function request(
  session: Session,
  path: string,
  accept: string,
  /**
   * Writes go through the same function as reads on purpose: every
   * status this maps — a rejected token, the wrong org, a missing API — means
   * the same thing whichever verb asked, and a second transport would be a
   * second place for those messages to drift.
   */
  init?: { method?: string; body?: string },
): Promise<Response> {
  const base = session.apiUrl.replace(/\/$/, "");
  const url = `${base}${path}`;

  let response: Response;
  try {
    response = await appFetch(url, {
      method: init?.method ?? "GET",
      headers: {
        ...headers(session),
        Accept: accept,
        ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(init?.body === undefined ? {} : { body: init.body }),
    });
  } catch (error) {
    // No HTTP status at all — DNS, TLS, offline, or a base URL that isn't a host.
    throw new Spec0Error(
      `Couldn't reach ${base} — ${error instanceof Error ? error.message : String(error)}`,
      0,
      url,
      "",
    );
  }

  if (response.ok) return response;

  const body = await response.text().catch(() => "");
  const detail = describeBody(body);
  const where = `${path} → HTTP ${response.status}`;

  if (response.status === 401) {
    throw new Spec0Error(
      `The token was rejected (401). ${detail ?? "It may have been revoked — signing in again on another device or in the CLI rotates it."} [${where}]`,
      401,
      url,
      body,
    );
  }
  if (response.status === 403) {
    throw new Spec0Error(
      `Authenticated, but not allowed (403). ${detail ?? `Check that org ${session.orgId} is the one this token belongs to.`} [${where}]`,
      403,
      url,
      body,
    );
  }
  if (response.status === 402) {
    // A limit reached. The server's own sentence is the message, as is.
    throw new Spec0Error(detail ?? "Your organisation has reached a limit.", 402, url, body);
  }
  if (response.status === 404) {
    throw new Spec0Error(
      `${base} doesn't serve this route (404). Is the API base URL right? [${where}]`,
      404,
      url,
      body,
    );
  }
  throw new Spec0Error(`spec0 returned ${response.status}. ${detail ?? ""} [${where}]`, response.status, url, body);
}

async function get<T>(session: Session, path: string): Promise<T> {
  const response = await request(session, path, "application/json");
  return (await response.json()) as T;
}

/**
 * Confirm the credentials actually reach the platform before storing them.
 *
 * A browser redirect only proves the user authorised us; it doesn't prove the
 * token and API base are usable together. Two routes are tried because they fail
 * for different reasons — if the org summary is unavailable but the API list
 * works, the token is fine and the problem is narrower than "sign in again".
 */
export async function verify(session: Session): Promise<void> {
  try {
    await get<unknown>(session, "/api/v1/public/orgs/summary");
    return;
  } catch (error) {
    if (!(error instanceof Spec0Error) || error.status === 0 || error.status === 401) throw error;
    // 403/404/5xx on this one route doesn't mean the token is bad — probe a second.
    try {
      await get<unknown>(session, "/api/v1/public/apis/team");
    } catch {
      throw error;
    }
  }
}

/** The org's private, team-scoped APIs. */
export async function listTeamApis(session: Session): Promise<TeamApi[]> {
  const rows = await get<TeamApi[]>(session, "/api/v1/public/apis/team");
  return rows.filter((row) => row.apiId && row.apiName);
}

/** Hosted mocks, so they can appear as selectable servers. */
export async function listMocks(session: Session): Promise<MockServer[]> {
  const rows = await get<MockServer[]>(session, "/api/v1/public/mocks");
  return rows.filter((row) => row.mockBaseUrl);
}

/**
 * One environment an API is deployed to, as the platform reports it.
 *
 * A **destination**, not a client environment: a name the org chose and the
 * URL it serves at. It carries no variables and no secrets — those are the
 * developer's and never leave this machine.
 */
export interface EnvTarget {
  name: string;
  url: string;
  /** The spec version live there, or null if nothing has been published to it. */
  currentVersion?: string | null;
  updatedAt?: string | null;
}

/**
 * Where an API actually runs, in the org's own order.
 *
 * The array's order is the promotion order the platform holds — there is no field
 * to sort by, deliberately — so it is preserved as received.
 *
 * A 404 comes back as "no environments" rather than an error, on purpose. It
 * can mean the API has been removed or isn't visible to this org, or a platform
 * that doesn't serve this route. In every case there are no targets to offer,
 * and this only enriches an API that already opened fine — failing the open
 * over it would trade a working client for a missing convenience. (Unlike
 * `refreshMock`, there is no action here the user could be told to take.)
 */
export async function listApiEnvironments(
  session: Session,
  apiId: string,
): Promise<EnvTarget[]> {
  try {
    const rows = await get<Array<Record<string, unknown>>>(
      session,
      `/api/v1/public/apis/team/${encodeURIComponent(apiId)}/environments`,
    );
    return rows
      .map((row) => ({
        name: String(row.name ?? ""),
        url: String(row.url ?? ""),
        currentVersion: (row.currentVersion as string | null) ?? null,
        updatedAt: (row.updatedAt as string | null) ?? null,
      }))
      .filter((row) => row.name && row.url);
  } catch (error) {
    if (error instanceof Spec0Error && error.status === 404) return [];
    throw error;
  }
}

/**
 * How many consumers depend on an API.
 *
 * A consumer is a team or service holding a grant on the API — the blast-radius
 * answer to "if I change this, who is affected". Studio shows the count and
 * hands the detail off to the dashboard rather than restating it: who consumes
 * what is an org-governance question with its own screen, approval flow and
 * permissions, and a desktop client that re-implemented a slice of that would
 * only be a second, staler place to read it.
 *
 * Counts only, deliberately. The names of consuming teams are org information
 * that the platform surfaces under its own access rules; the count is enough to
 * tell you whether to go and look.
 */
export interface ApiConsumers {
  total: number;
  approved: number;
}

/**
 * Null rather than an error whenever the answer isn't available — a platform
 * that predates this endpoint, an API the caller can't see, or a token that no
 * longer works. This decorates an API that already opened; nothing about it is
 * worth failing an open over.
 */
export async function getApiConsumers(
  session: Session,
  apiId: string,
): Promise<ApiConsumers | null> {
  try {
    const row = await get<Record<string, unknown>>(
      session,
      `/api/v1/public/apis/team/${encodeURIComponent(apiId)}/consumers`,
    );
    const total = Number(row.total ?? 0);
    const approved = Number(row.approved ?? 0);
    if (!Number.isFinite(total) || !Number.isFinite(approved)) return null;
    return { total, approved };
  } catch (error) {
    if (error instanceof Spec0Error && (error.status === 404 || error.status === 403)) return null;
    throw error;
  }
}

/** A team in the calling org — the destination choice when publishing. */
export interface TeamSummary {
  id: string;
  name: string;
}

/**
 * Teams the token's org has.
 *
 * Empty rather than an error when the platform won't say: publishing without a
 * team is legal — the API lands in the org's "Unassigned APIs" team — so a
 * failure to list them narrows the choice rather than blocking the publish.
 */
export async function listTeams(session: Session): Promise<TeamSummary[]> {
  try {
    const rows = await get<Array<Record<string, unknown>>>(session, "/api/v1/public/teams");
    return rows
      .map((row) => ({ id: String(row.id ?? ""), name: String(row.name ?? "") }))
      .filter((row) => row.id && row.name);
  } catch (error) {
    if (error instanceof Spec0Error && (error.status === 403 || error.status === 404)) return [];
    throw error;
  }
}

/**
 * Publish a spec to a team-scoped API — the endpoint `spec0 push` targets.
 *
 * Errors are deliberately not swallowed the way the read paths swallow theirs.
 * A missing consumer count is a decoration that failed; a failed publish is
 * work that didn't happen, and the caller has to be able to say why — including
 * when the platform's own lint gate is the reason.
 */
export async function publishTeamApi<T>(session: Session, body: unknown): Promise<T> {
  const response = await request(session, "/api/v1/public/apis/team", "application/json", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return (await response.json()) as T;
}

/**
 * Deep link to an API on the dashboard — where a publish lands.
 */
export function apiUrl(appUrl: string, apiId: string): string {
  return `${appUrl.replace(/\/+$/, "")}/apis/${encodeURIComponent(apiId)}`;
}

/**
 * Deep link to the API's consumers on the dashboard.
 *
 * The details page routes its tabs as `?tab=…&sub=…`; consumers live under the
 * operations tab. Built here so the one place that knows the platform's URL
 * shape is the platform client.
 */
export function consumersUrl(appUrl: string, apiId: string): string {
  const base = appUrl.replace(/\/+$/, "");
  return `${base}/apis/${encodeURIComponent(apiId)}?tab=operations&sub=subscribers`;
}

/** APIs the org has published to the registry — these can actually be opened. */
export async function listRegistryApis(session: Session): Promise<RegistryEntry[]> {
  const rows = await get<Array<Record<string, unknown>>>(session, "/api/v1/public/apis");
  return rows
    .map((row) => ({
      apiSlug: String(row.apiSlug ?? ""),
      title: String(row.title ?? row.apiSlug ?? ""),
      version: (row.latestVersion as string) ?? null,
      description: (row.description as string) ?? null,
      visibility: (row.visibility as string) ?? null,
    }))
    .filter((row) => row.apiSlug);
}

/**
 * The latest published spec for any API in the org, by UUID.
 *
 * The route declares `application/json` with a `string` schema, so the body is a
 * JSON-encoded string rather than the document itself — unwrap it, but fall back to
 * the raw text in case a future version returns YAML directly.
 */
export async function fetchTeamApiSpec(session: Session, apiId: string): Promise<string> {
  const response = await request(
    session,
    `/api/v1/public/apis/team/${encodeURIComponent(apiId)}/spec`,
    "application/json, application/yaml, text/plain",
  );
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "string") return parsed;
  } catch {
    /* already a raw document */
  }
  return text;
}

/**
 * The org's whole catalog in one list.
 *
 * `listTeamApis` is the complete set of APIs the org owns; `listPublicApis` is the
 * subset also in the registry, used here only to badge rows. Mocks are folded in at
 * the same time so a row can say up front that it has one.
 */
export async function loadCatalog(session: Session): Promise<CatalogEntry[]> {
  const [teams, published, mocks] = await Promise.all([
    listTeamApis(session),
    listRegistryApis(session).catch(() => [] as RegistryEntry[]),
    listMocks(session).catch(() => [] as MockServer[]),
  ]);

  const publicSlugs = new Set(published.map((row) => row.apiSlug));
  return teams
    .map((api) => ({
      apiId: api.apiId,
      apiName: api.apiName,
      version: api.version,
      description: api.description,
      teamName: api.teamName,
      isPublic: publicSlugs.has(api.apiName),
      mockServerId: mocks.find((m) => m.apiId === api.apiId)?.mockServerId ?? null,
      mockUrl: absoluteMockUrl(
        session.apiUrl,
        mocks.find((m) => m.apiId === api.apiId || m.apiName === api.apiName)?.mockBaseUrl,
      ),
      mockSpecVersion:
        mocks.find((m) => m.apiId === api.apiId || m.apiName === api.apiName)?.specVersion ?? null,
    }))
    .sort((a, b) => a.apiName.localeCompare(b.apiName));
}

/** The latest published spec document for a registry API, verbatim. */
export async function fetchRegistrySpec(
  session: Session,
  apiSlug: string,
): Promise<string> {
  const orgSlug = session.orgSlug?.trim();
  if (!orgSlug) {
    throw new Spec0Error(
      "No org slug set. The registry route needs it and the public API doesn't return it — set it in the spec0 tab.",
      0,
      "",
      "",
    );
  }
  const response = await request(
    session,
    `/api/v1/public/registry/${encodeURIComponent(orgSlug)}/${encodeURIComponent(apiSlug)}`,
    "application/yaml, application/json, text/plain",
  );
  return response.text();
}

/** Mock base URL for an API, if one is provisioned. */
export function mockUrlFor(mocks: MockServer[], apiName: string): string | null {
  return mocks.find((mock) => mock.apiName === apiName)?.mockBaseUrl ?? null;
}

/** One hosted mock as the Mocks tab lists it. */
export interface MockRow {
  /** Stable key for the list. */
  key: string;
  mockServerId: string | null;
  apiId: string | null;
  /** The API the mock serves. */
  apiName: string;
  /** The mock's own name, when it has one different from the API's. */
  name: string | null;
  /** Absolute, so it can be copied into a terminal as is. */
  url: string;
  specVersion: string | null;
}

/**
 * Hosted mocks as rows to show: absolute URLs, one name per API, sorted by API
 * name. A mock with no usable URL is left out, since there's nothing to call.
 */
export function describeMocks(mocks: MockServer[], apiUrl: string): MockRow[] {
  const rows: MockRow[] = [];
  for (const mock of mocks) {
    const url = absoluteMockUrl(apiUrl, mock.mockBaseUrl);
    if (!url) continue;
    const apiName = mock.apiName?.trim() || mock.name?.trim() || "Unnamed API";
    const name = mock.name?.trim() && mock.name.trim() !== apiName ? mock.name.trim() : null;
    rows.push({
      key: mock.mockServerId ?? url,
      mockServerId: mock.mockServerId ?? null,
      apiId: mock.apiId ?? null,
      apiName,
      name,
      url,
      specVersion: mock.specVersion ?? null,
    });
  }
  return rows.sort((a, b) => a.apiName.localeCompare(b.apiName) || a.url.localeCompare(b.url));
}

export interface CreatedMock {
  mockServerId?: string;
  apiName?: string;
  mockUrl: string | null;
  created?: boolean;
  /**
   * Returned on first creation. The list endpoint never carries it, and creating
   * again on an existing mock returns null — then `getMockApiKey` fetches it.
   */
  apiKey?: string | null;
}

/** Provision a mock for an API. Idempotent: an existing mock is returned as-is. */
export async function createMock(session: Session, apiId: string): Promise<CreatedMock> {
  const base = session.apiUrl.replace(/\/$/, "");
  let response: Response;
  try {
    response = await appFetch(`${base}/api/v1/public/mocks`, {
    method: "POST",
    headers: { ...headers(session), "Content-Type": "application/json" },
    body: JSON.stringify({ apiId }),
  });
  } catch (error) {
    throw new Spec0Error(
      `Couldn't reach ${base} — ${error instanceof Error ? error.message : String(error)}`,
      0,
      `${base}/api/v1/public/mocks`,
      "",
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    if (response.status === 402) {
      throw new Spec0Error(
        describeBody(body) ?? "Your organisation has reached a limit.",
        402,
        `${base}/api/v1/public/mocks`,
        body,
      );
    }
    throw new Spec0Error(
      `Couldn't create the mock (HTTP ${response.status}). ${describeBody(body) ?? ""}`,
      response.status,
      `${base}/api/v1/public/mocks`,
      body,
    );
  }
  const json = (await response.json()) as Record<string, unknown>;
  return {
    mockServerId: json.mockServerId as string,
    apiName: json.apiName as string,
    mockUrl: absoluteMockUrl(session.apiUrl, json.mockBaseUrl as string),
    created: json.created as boolean,
    apiKey: (json.apiKey as string) ?? null,
  };
}

// ── Update detection ───────────────────────────────────────────────────────────

/** The API id inside a `spec0:<apiId>` library source ref, or null. */
export function apiIdFromRef(ref: string): string | null {
  const id = ref.startsWith("spec0:") ? ref.slice("spec0:".length) : null;
  return id && id.length > 0 ? id : null;
}

/**
 * The API whose platform environments should be loaded when a library entry
 * opens, or null when there is nothing to load: no session, or an API that
 * didn't come from spec0.
 */
export function environmentSyncApiId(
  session: Session | null,
  source: { kind: string; ref: string },
): string | null {
  if (!session || source.kind !== "spec0") return null;
  return apiIdFromRef(source.ref);
}

export interface UpstreamState {
  apiId: string;
  version?: string | null;
  updatedAt?: string | null;
}

/**
 * What the catalog currently holds for each API, keyed by id.
 *
 * Detection is one `listTeamApis` call for the whole library rather than a probe
 * per API: the list already carries `version` and `updatedAt`, so there is
 * nothing to add server-side and nothing to poll.
 */
export async function upstreamVersions(session: Session): Promise<Map<string, UpstreamState>> {
  const rows = await listTeamApis(session);
  return new Map(
    rows.map((row) => [row.apiId, { apiId: row.apiId, version: row.version, updatedAt: row.updatedAt }]),
  );
}

/**
 * Is what upstream holds different from what we stored?
 *
 * Compares the version tag first and falls back to `updatedAt`, because an API
 * can be republished under the same `info.version` — treating the tag as the only
 * signal would miss exactly the republish a developer most wants to know about.
 * Both absent means we can't tell, and claiming an update we can't substantiate
 * is worse than staying quiet.
 */
export function hasUpdate(
  local: { version?: string; syncedAt?: string },
  upstream: UpstreamState | undefined,
): boolean {
  if (!upstream) return false;
  if (upstream.version && local.version && upstream.version !== local.version) return true;
  if (upstream.updatedAt && local.syncedAt) {
    const up = Date.parse(upstream.updatedAt);
    const mine = Date.parse(local.syncedAt);
    if (!Number.isNaN(up) && !Number.isNaN(mine) && up > mine) return true;
  }
  return false;
}

export interface RefreshedMock {
  mockServerId?: string;
  specVersion?: string | null;
  refreshed?: boolean;
  customVariantsCarriedOver?: number;
  customVariantsDropped?: string[];
}

/**
 * Rebuild a mock against its API's current spec.
 *
 * The mock keeps its id, URL and API key — the platform swaps the engine mock
 * behind a stable handle — so nothing a consumer holds has to change. Request
 * logs, environment variables and per-operation settings move with it.
 */
export async function refreshMock(session: Session, mockServerId: string): Promise<RefreshedMock> {
  const base = session.apiUrl.replace(/\/$/, "");
  const url = `${base}/api/v1/public/mocks/${encodeURIComponent(mockServerId)}/refresh`;
  const response = await appFetch(url, { method: "POST", headers: headers(session) });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    if (response.status === 404) {
      // Every platform serves this route now, so a 404 means the mock itself is
      // gone (deleted, or not visible to this org). The mock id cached on the
      // library entry is what went stale; re-pulling the API replaces it.
      throw new Spec0Error(
        "That mock server no longer exists — it may have been deleted. Re-pull the API from spec0 to pick up its current mock.",
        404,
        url,
        body,
      );
    }
    throw new Spec0Error(
      `Couldn't refresh the mock (HTTP ${response.status}). ${describeBody(body) ?? ""}`,
      response.status,
      url,
      body,
    );
  }
  return (await response.json()) as RefreshedMock;
}

// ── Mock keys ──────────────────────────────────────────────────────────────────

export interface MockKey {
  mockServerId: string;
  apiKey: string;
  apiKeyPreview?: string | null;
}

function toMockKey(json: Record<string, unknown>, mockServerId: string): MockKey | null {
  const apiKey = typeof json.apiKey === "string" ? json.apiKey : "";
  if (!apiKey) return null;
  return {
    mockServerId: typeof json.mockServerId === "string" ? json.mockServerId : mockServerId,
    apiKey,
    apiKeyPreview: typeof json.apiKeyPreview === "string" ? json.apiKeyPreview : null,
  };
}

/**
 * A mock's API key, for a mock Studio didn't create (or created before it
 * could fetch keys).
 *
 * Null when the platform won't give it: a 404 means the route isn't there yet,
 * the mock is unknown, or this token may not read it. The caller then falls back
 * to asking the user to paste the key.
 */
export async function getMockApiKey(session: Session, mockServerId: string): Promise<MockKey | null> {
  try {
    const json = await get<Record<string, unknown>>(
      session,
      `/api/v1/public/mocks/${encodeURIComponent(mockServerId)}/api-key`,
    );
    return toMockKey(json, mockServerId);
  } catch (error) {
    if (error instanceof Spec0Error && (error.status === 404 || error.status === 403)) return null;
    throw error;
  }
}

/**
 * The key for a mock Studio knows by id, or only by its API's id (older
 * library entries). Null — never an error — when Spec0 won't give it, so the
 * caller can fall back to asking the user to paste it.
 */
export async function resolveMockKey(
  session: Session,
  known: { mockServerId: string | null; apiId: string | null },
): Promise<MockKey | null> {
  try {
    let id = known.mockServerId;
    if (!id && known.apiId) {
      id = (await listMocks(session)).find((row) => row.apiId === known.apiId)?.mockServerId ?? null;
    }
    return id ? await getMockApiKey(session, id) : null;
  } catch {
    return null;
  }
}

/** Replace a mock's API key. The old key stops working straight away. */
export async function regenerateMockApiKey(session: Session, mockServerId: string): Promise<MockKey> {
  const response = await request(
    session,
    `/api/v1/public/mocks/${encodeURIComponent(mockServerId)}/api-key/regenerate`,
    "application/json",
    { method: "POST" },
  );
  const key = toMockKey((await response.json()) as Record<string, unknown>, mockServerId);
  if (!key) throw new Spec0Error("Spec0 didn't return a new key.", response.status, response.url, "");
  return key;
}

// ── Entitlements ───────────────────────────────────────────────────────────────

/** One counted allowance, as the platform reports it. `limit: -1` means no limit. */
export interface Allowance {
  key: string;
  limit: number;
  used: number;
  enabled: boolean;
}

export interface Entitlements {
  features: Allowance[];
}

/**
 * What the organisation may still create, if the platform says.
 *
 * Null when it doesn't — a 404 from a platform without this route, or a
 * refusal. Callers treat null as "unknown" and simply don't show usage; the
 * create call itself still reports a limit if one is hit.
 */
export async function getEntitlements(session: Session): Promise<Entitlements | null> {
  try {
    const json = await get<Record<string, unknown>>(session, "/api/v1/public/orgs/entitlements");
    const rows = Array.isArray(json.features) ? (json.features as Array<Record<string, unknown>>) : [];
    return {
      features: rows
        .map((row) => ({
          key: String(row.key ?? ""),
          limit: Number(row.limit ?? -1),
          used: Number(row.used ?? 0),
          enabled: row.enabled !== false,
        }))
        .filter((row) => row.key && Number.isFinite(row.limit) && Number.isFinite(row.used)),
    };
  } catch (error) {
    if (error instanceof Spec0Error && (error.status === 404 || error.status === 403)) return null;
    throw error;
  }
}

/** The fields of a limit-reached (402) Problem that Studio uses. */
export interface PlanLimit {
  detail: string;
  feature: string | null;
}

/** Read a 402 Problem body. Null when the error isn't one. */
export function planLimitOf(error: unknown): PlanLimit | null {
  if (!(error instanceof Spec0Error) || error.status !== 402) return null;
  try {
    const json = JSON.parse(error.body) as Record<string, unknown>;
    return {
      detail: typeof json.detail === "string" && json.detail.trim() ? json.detail.trim() : error.message,
      feature: typeof json.feature === "string" ? json.feature : null,
    };
  } catch {
    return { detail: error.message, feature: null };
  }
}
