import { useCallback, useEffect, useState } from "react";
import { transportFor, type ConnectionSettings } from "../lib/connection";
import type { LibraryEntry } from "../lib/library";
import {
  buildAuthorizeUrl,
  createChallenge,
  createVerifier,
  exchangeAuthorizationCode,
  fetchClientCredentialsToken,
  isExpired,
  loadToken,
  refreshAccessToken,
  saveToken,
  type CachedToken,
  type OAuthConfig,
} from "../lib/oauth";
import { awaitOAuthCallback, openInBrowser } from "../lib/store";

/**
 * The OAuth token for the open API in the active environment.
 *
 * Tokens are cache, keyed by API *and* environment, so switching either one
 * loads the matching token (or none).
 */
export function useOAuth(
  current: LibraryEntry | null,
  activeEnvId: string | null,
  vars: Record<string, string>,
  connection: ConnectionSettings,
) {
  const [oauthToken, setOauthToken] = useState<CachedToken | null>(null);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);

  useEffect(() => {
    if (!current?.id) {
      setOauthToken(null);
      return;
    }
    void loadToken(current.id, activeEnvId).then(setOauthToken);
  }, [current?.id, activeEnvId]);

  /**
   * Obtain a token, by whichever grant is configured.
   *
   * Both grants end the same way — a token in the cache keyed by API and
   * environment — so the caller doesn't branch on which one ran.
   */
  const acquireToken = useCallback(
    async (config: OAuthConfig) => {
      if (!current) return;
      setOauthBusy(true);
      setOauthError(null);
      try {
        const transport = transportFor(connection, config.tokenUrl);
        let token: CachedToken;
        if (config.grant === "client_credentials") {
          token = await fetchClientCredentialsToken(config, vars, transport);
        } else {
          const verifier = createVerifier();
          const challenge = await createChallenge(verifier);
          const state = createVerifier(24);
          const port = 8127;
          const redirectUri = `http://127.0.0.1:${port}/callback`;

          // Reuses the loopback listener built for spec0 sign-in — a webview
          // can't hold a socket, and this is the same shape of handshake.
          const waiting = awaitOAuthCallback(port, 180);
          await openInBrowser(buildAuthorizeUrl(config, challenge, state, redirectUri));
          const params = await waiting;

          if (params.state !== state) {
            // A mismatched state means the response didn't come from the
            // request we made — refusing is the whole point of sending it.
            throw new Error("The authorization response didn't match this request. Try again.");
          }
          if (params.error) {
            throw new Error(params.error_description ?? params.error);
          }
          if (!params.code) throw new Error("The browser came back without an authorization code.");
          token = await exchangeAuthorizationCode(
            config,
            params.code,
            verifier,
            redirectUri,
            vars,
            transport,
          );
        }
        await saveToken(current.id, activeEnvId, token);
        setOauthToken(token);
      } catch (error) {
        setOauthError(error instanceof Error ? error.message : String(error));
      } finally {
        setOauthBusy(false);
      }
    },
    [current, connection, vars, activeEnvId],
  );

  /**
   * The token to send, renewed first if it's close to expiring.
   *
   * Silent by design: a refresh that works is not news, and stopping to tell the
   * user would defeat the point of storing a refresh token.
   */
  const usableToken = useCallback(async (): Promise<string> => {
    const config = current?.oauth;
    if (!current || !config) return "";
    let token = oauthToken ?? (await loadToken(current.id, activeEnvId));
    if (token && isExpired(token) && token.refreshToken) {
      try {
        token = await refreshAccessToken(config, token, vars, transportFor(connection, config.tokenUrl));
        await saveToken(current.id, activeEnvId, token);
        setOauthToken(token);
      } catch {
        // A refresh that fails leaves the old token in place: it may still work,
        // and a 401 from the API is a clearer signal than a refresh error here.
      }
    }
    return token?.accessToken ?? "";
  }, [current, oauthToken, activeEnvId, vars, connection]);

  /** Forget the token for this API and environment. */
  const clearToken = useCallback(() => {
    if (!current) return;
    void saveToken(current.id, activeEnvId, null);
    setOauthToken(null);
  }, [current, activeEnvId]);

  return {
    oauthToken,
    oauthBusy,
    oauthError,
    setOauthError,
    acquireToken,
    usableToken,
    clearToken,
  };
}
