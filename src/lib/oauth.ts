import { appFetch, type Transport } from "./request";
import { interpolate } from "./env";
import { readStore, writeStore, STORE } from "./store";

/**
 * OAuth 2.0 token acquisition.
 *
 * Most internal APIs sit behind OAuth. Getting the token inside Studio saves
 * fetching one elsewhere and pasting it in every time it expires.
 *
 * ## Where things live, and why
 *
 * **The config lives with the API. The secret does not.** Client id, token and
 * authorization URLs and scopes are properties of the API (not secrets) and
 * belong on the library entry. The **client secret is a secret**, so it goes
 * where every other secret already goes: an environment variable marked secret,
 * referenced here as `{{clientSecret}}`. Studio's standing rule is that there is
 * no per-API secret store, and OAuth is not a reason to carve an
 * exception into it: it's the case the rule was written for.
 *
 * A useful consequence: staging and production credentials are just two
 * environments, and switching environments switches which credentials are used.
 *
 * **Acquired tokens are cache, not configuration.** They're keyed by API *and*
 * environment so credentials never cross, kept in their own uncommitted file,
 * and refreshed rather than re-prompted.
 */

export type Grant = "client_credentials" | "authorization_code";

/** How the client authenticates to the token endpoint. Providers differ. */
export type ClientAuth = "body" | "basic";

export interface OAuthConfig {
  grant: Grant;
  tokenUrl: string;
  /** Required for `authorization_code`. */
  authorizationUrl?: string;
  clientId: string;
  /**
   * How to find the client secret: a `{{variable}}` reference, not a literal.
   *
   * Stored as a reference so the secret itself stays in the environment's secret
   * store. A literal here would be a per-API secret store by the back door.
   */
  clientSecretRef: string;
  scopes: string[];
  /** Sent as `audience`; several providers require it and omitting it 400s. */
  audience?: string;
  clientAuth: ClientAuth;
}

export interface CachedToken {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. Absent when the server didn't say, in which case we don't guess. */
  expiresAt?: number;
  scope?: string;
  tokenType?: string;
}

export const DEFAULT_OAUTH: OAuthConfig = {
  grant: "client_credentials",
  tokenUrl: "",
  clientId: "",
  clientSecretRef: "{{clientSecret}}",
  scopes: [],
  clientAuth: "body",
};

/** Refresh this far before expiry, so a request never rides an about-to-die token. */
const RENEW_MARGIN_MS = 60_000;

type TokenCache = Record<string, CachedToken>;

/**
 * Cache key: the API *and* the environment.
 *
 * Both matter. Same API with staging vs production credentials must not share a
 * token, or a switch of environment silently keeps talking to the old one with
 * the old credentials.
 */
export function tokenKey(apiId: string, envId: string | null): string {
  return `${apiId}:${envId ?? "none"}`;
}

export async function loadToken(apiId: string, envId: string | null): Promise<CachedToken | null> {
  const cache = await readStore<TokenCache>(STORE.tokens, {});
  return cache[tokenKey(apiId, envId)] ?? null;
}

export async function saveToken(
  apiId: string,
  envId: string | null,
  token: CachedToken | null,
): Promise<void> {
  const cache = await readStore<TokenCache>(STORE.tokens, {});
  const key = tokenKey(apiId, envId);
  if (token) cache[key] = token;
  else delete cache[key];
  await writeStore(STORE.tokens, cache);
}

export function isExpired(token: CachedToken | null, now = Date.now()): boolean {
  if (!token?.accessToken) return true;
  // No expiry stated means we genuinely don't know. Treating that as "expired"
  // would re-authenticate on every send against servers that simply don't say.
  if (token.expiresAt === undefined) return false;
  return token.expiresAt - RENEW_MARGIN_MS <= now;
}

/** Something readable for the UI: "expires in 42m", or how long ago it lapsed. */
export function describeExpiry(token: CachedToken | null, now = Date.now()): string {
  if (!token?.accessToken) return "no token";
  if (token.expiresAt === undefined) return "no expiry reported";
  const delta = token.expiresAt - now;
  if (delta <= 0) return "expired";
  const minutes = Math.round(delta / 60_000);
  if (minutes < 1) return "expires in under a minute";
  if (minutes < 60) return `expires in ${minutes}m`;
  return `expires in ${Math.round(minutes / 60)}h`;
}

/**
 * A token-endpoint failure, phrased as the specific problem it is.
 *
 * OAuth misconfiguration produces some of the worst error messages in software,
 * and "401" tells you nothing about which of five things is wrong. A rejected
 * secret, a rejected scope and an unreachable URL must read as three different
 * problems or the user is left bisecting their config by hand.
 */
export class OAuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

function describeTokenFailure(status: number, body: string): OAuthError {
  let parsed: { error?: string; error_description?: string } = {};
  try {
    parsed = JSON.parse(body);
  } catch {
    // A token endpoint that doesn't answer JSON is usually the wrong URL:
    // an HTML login page or a 404 from the API's own host.
    const looksLikeHtml = /^\s*<(!doctype|html)/i.test(body);
    return new OAuthError(
      looksLikeHtml
        ? "The token URL returned an HTML page, not a token. That's usually a sign-in page or the wrong URL."
        : `The token URL answered ${status} with something that isn't JSON.`,
      "not_json",
      body.slice(0, 300),
    );
  }

  const code = parsed.error ?? `http_${status}`;
  const detail = parsed.error_description;
  switch (parsed.error) {
    case "invalid_client":
      return new OAuthError(
        "The client id or client secret was rejected. Check both, and whether this provider expects them in the body or as Basic auth.",
        code,
        detail,
      );
    case "invalid_scope":
      return new OAuthError(
        "The authorization server rejected the requested scopes. Remove the ones this client isn't allowed.",
        code,
        detail,
      );
    case "unauthorized_client":
      return new OAuthError(
        "This client isn't allowed to use that grant type.",
        code,
        detail,
      );
    case "invalid_grant":
      return new OAuthError(
        "The grant was rejected: an authorization code that was already used or has expired, or a refresh token the server no longer accepts.",
        code,
        detail,
      );
    default:
      return new OAuthError(
        detail ? `Token request failed: ${detail}` : `Token request failed (${code}).`,
        code,
        detail,
      );
  }
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

function toCachedToken(payload: TokenResponse, previous?: CachedToken | null): CachedToken {
  return {
    accessToken: payload.access_token ?? "",
    // Servers may omit the refresh token on renewal and expect the old one to
    // keep working; dropping it there would turn every refresh into the last.
    refreshToken: payload.refresh_token ?? previous?.refreshToken,
    expiresAt:
      typeof payload.expires_in === "number"
        ? Date.now() + payload.expires_in * 1000
        : undefined,
    scope: payload.scope,
    tokenType: payload.token_type ?? "Bearer",
  };
}

async function postToken(
  tokenUrl: string,
  form: Record<string, string>,
  auth: { clientId: string; clientSecret: string; mode: ClientAuth },
  transport: Transport,
): Promise<TokenResponse> {
  const body = new URLSearchParams(form);
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (auth.mode === "basic") {
    headers.Authorization = `Basic ${btoa(`${auth.clientId}:${auth.clientSecret}`)}`;
  } else {
    body.set("client_id", auth.clientId);
    if (auth.clientSecret) body.set("client_secret", auth.clientSecret);
  }

  let response: Response;
  try {
    response = await appFetch(tokenUrl, {
      method: "POST",
      headers,
      body: body.toString(),
      transport,
    });
  } catch (error) {
    throw new OAuthError(
      `Couldn't reach the token URL (${tokenUrl}). ${error instanceof Error ? error.message : String(error)}`,
      "unreachable",
    );
  }

  const text = await response.text();
  if (!response.ok) throw describeTokenFailure(response.status, text);

  try {
    const payload = JSON.parse(text) as TokenResponse;
    if (!payload.access_token) {
      throw new OAuthError(
        "The token endpoint answered successfully but returned no access_token.",
        "no_access_token",
        text.slice(0, 300),
      );
    }
    return payload;
  } catch (error) {
    if (error instanceof OAuthError) throw error;
    throw describeTokenFailure(response.status, text);
  }
}

/** Resolve `{{clientSecret}}` against the active environment. */
export function resolveSecret(config: OAuthConfig, vars: Record<string, string>): string {
  return interpolate(config.clientSecretRef, vars).trim();
}

export async function fetchClientCredentialsToken(
  config: OAuthConfig,
  vars: Record<string, string>,
  transport: Transport = {},
): Promise<CachedToken> {
  const form: Record<string, string> = { grant_type: "client_credentials" };
  if (config.scopes.length) form.scope = config.scopes.join(" ");
  if (config.audience) form.audience = config.audience;

  const payload = await postToken(
    config.tokenUrl,
    form,
    { clientId: config.clientId, clientSecret: resolveSecret(config, vars), mode: config.clientAuth },
    transport,
  );
  return toCachedToken(payload);
}

export async function exchangeAuthorizationCode(
  config: OAuthConfig,
  code: string,
  verifier: string,
  redirectUri: string,
  vars: Record<string, string>,
  transport: Transport = {},
): Promise<CachedToken> {
  const payload = await postToken(
    config.tokenUrl,
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    },
    { clientId: config.clientId, clientSecret: resolveSecret(config, vars), mode: config.clientAuth },
    transport,
  );
  return toCachedToken(payload);
}

export async function refreshAccessToken(
  config: OAuthConfig,
  token: CachedToken,
  vars: Record<string, string>,
  transport: Transport = {},
): Promise<CachedToken> {
  if (!token.refreshToken) {
    throw new OAuthError("No refresh token was issued, so this one can't be renewed.", "no_refresh");
  }
  const form: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: token.refreshToken,
  };
  if (config.scopes.length) form.scope = config.scopes.join(" ");

  const payload = await postToken(
    config.tokenUrl,
    form,
    { clientId: config.clientId, clientSecret: resolveSecret(config, vars), mode: config.clientAuth },
    transport,
  );
  return toCachedToken(payload, token);
}

// PKCE

const VERIFIER_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

/** RFC 7636 code verifier: 43–128 chars from the unreserved set. */
export function createVerifier(length = 64): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => VERIFIER_ALPHABET[b % VERIFIER_ALPHABET.length]).join("");
}

export function base64UrlEncode(bytes: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** S256 challenge. Plain is not offered; it exists only for clients that can't hash. */
export async function createChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(digest);
}

export function buildAuthorizeUrl(
  config: OAuthConfig,
  challenge: string,
  state: string,
  redirectUri: string,
): string {
  const url = new URL(config.authorizationUrl ?? "");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (config.scopes.length) url.searchParams.set("scope", config.scopes.join(" "));
  if (config.audience) url.searchParams.set("audience", config.audience);
  return url.toString();
}

/** What's missing before this config can be used, in the order worth fixing it. */
export function configProblems(config: OAuthConfig): string[] {
  const problems: string[] = [];
  if (!config.clientId.trim()) problems.push("Client id is required.");
  if (!config.tokenUrl.trim()) problems.push("Token URL is required.");
  else if (!/^https?:\/\//i.test(config.tokenUrl)) problems.push("Token URL must be absolute.");
  if (config.grant === "authorization_code") {
    if (!config.authorizationUrl?.trim()) {
      problems.push("Authorization URL is required for the authorization-code grant.");
    } else if (!/^https?:\/\//i.test(config.authorizationUrl)) {
      problems.push("Authorization URL must be absolute.");
    }
  }
  return problems;
}
