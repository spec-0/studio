import { useMemo, useState } from "react";
import { KeyRound, Loader2, X } from "lucide-react";
import {
  DEFAULT_OAUTH,
  configProblems,
  describeExpiry,
  type CachedToken,
  type OAuthConfig,
} from "../lib/oauth";
import type { SecuritySchemeSpec } from "../lib/spec";

interface Props {
  config: OAuthConfig | null;
  token: CachedToken | null;
  /** Declared oauth2 schemes, used to pre-fill what the document already states. */
  schemes: SecuritySchemeSpec[];
  /** Name of the scheme to pre-fill from, when opened by picking one. */
  prefillFrom?: string;
  /** Variables in the active environment, for the secret-reference hint. */
  varNames: string[];
  activeEnvName: string | null;
  busy: boolean;
  error: string | null;
  onSave: (config: OAuthConfig) => void;
  onAcquire: (config: OAuthConfig) => void;
  onClear: () => void;
  onClose: () => void;
}

/**
 * OAuth 2.0 setup for one API.
 *
 * Pre-fills from the spec wherever the document already says something. Asking
 * someone to retype a token URL that OpenAPI declares is exactly what a
 * spec-native client should never do.
 */
export function OAuthDialog({
  config,
  token,
  schemes,
  prefillFrom,
  varNames,
  activeEnvName,
  busy,
  error,
  onSave,
  onAcquire,
  onClear,
  onClose,
}: Props) {
  const oauthSchemes = useMemo(
    () => schemes.filter((scheme) => scheme.type === "oauth2" && scheme.flows?.length),
    [schemes],
  );

  const [draft, setDraft] = useState<OAuthConfig>(() => {
    if (config) return config;
    const source =
      oauthSchemes.find((scheme) => scheme.name === prefillFrom) ?? oauthSchemes[0] ?? null;
    const flow =
      source?.flows?.find((f) => f.kind === "clientCredentials") ??
      source?.flows?.find((f) => f.kind === "authorizationCode") ??
      source?.flows?.[0];
    if (!flow) return DEFAULT_OAUTH;
    return {
      ...DEFAULT_OAUTH,
      grant: flow.kind === "authorizationCode" ? "authorization_code" : "client_credentials",
      tokenUrl: flow.tokenUrl ?? "",
      authorizationUrl: flow.authorizationUrl,
      scopes: [],
    };
  });

  const declaredScopes = useMemo(() => {
    const all = oauthSchemes.flatMap((scheme) => scheme.flows ?? []).flatMap((flow) => flow.scopes);
    const seen = new Map<string, string>();
    for (const scope of all) if (!seen.has(scope.name)) seen.set(scope.name, scope.description);
    return [...seen.entries()].map(([name, description]) => ({ name, description }));
  }, [oauthSchemes]);

  const problems = configProblems(draft);
  const patch = (next: Partial<OAuthConfig>) => setDraft((prev) => ({ ...prev, ...next }));
  const toggleScope = (name: string) =>
    patch({
      scopes: draft.scopes.includes(name)
        ? draft.scopes.filter((s) => s !== name)
        : [...draft.scopes, name],
    });

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal wide" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <strong>OAuth 2.0</strong>
          <span className="spacer" />
          <button className="icon-btn tight" onClick={onClose} aria-label="Close">
            <X size={15} />
          </button>
        </div>

        <div className="modal-body">
          {oauthSchemes.length > 0 && !config && (
            <div className="verdict none" style={{ marginBottom: 12 }}>
              <span className="glyph">✓</span>
              <span>Pre-filled from this spec's declared flows — check the client id and scopes.</span>
            </div>
          )}

          <section className="section">
            <h3>Grant</h3>
            <select
              value={draft.grant}
              onChange={(event) => patch({ grant: event.target.value as OAuthConfig["grant"] })}
            >
              <option value="client_credentials">Client credentials (service to service)</option>
              <option value="authorization_code">Authorization code + PKCE (sign in as a user)</option>
            </select>
          </section>

          <section className="section">
            <h3>Endpoints</h3>
            <div className="field">
              <div className="field-label">
                <div className="field-name">token URL</div>
              </div>
              <input
                value={draft.tokenUrl}
                placeholder="https://auth.example.com/oauth/token"
                onChange={(event) => patch({ tokenUrl: event.target.value })}
              />
            </div>
            {draft.grant === "authorization_code" && (
              <div className="field">
                <div className="field-label">
                  <div className="field-name">authorize URL</div>
                </div>
                <input
                  value={draft.authorizationUrl ?? ""}
                  placeholder="https://auth.example.com/authorize"
                  onChange={(event) => patch({ authorizationUrl: event.target.value })}
                />
              </div>
            )}
            <div className="field">
              <div className="field-label">
                <div className="field-name">audience</div>
                <div className="field-meta">optional</div>
              </div>
              <input
                value={draft.audience ?? ""}
                placeholder="https://api.example.com — required by some providers"
                onChange={(event) => patch({ audience: event.target.value })}
              />
            </div>
          </section>

          <section className="section">
            <h3>Client</h3>
            <div className="field">
              <div className="field-label">
                <div className="field-name">client id</div>
              </div>
              <input
                value={draft.clientId}
                onChange={(event) => patch({ clientId: event.target.value })}
              />
            </div>
            <div className="field">
              <div className="field-label">
                <div className="field-name">client secret</div>
              </div>
              <input
                value={draft.clientSecretRef}
                placeholder="{{clientSecret}}"
                onChange={(event) => patch({ clientSecretRef: event.target.value })}
              />
            </div>
            <div className="field-meta">
              A <strong>reference</strong>, not the secret itself. Put the value in{" "}
              {activeEnvName ? <>the <strong>{activeEnvName}</strong> environment</> : "an environment"}{" "}
              as a secret variable — that keeps it out of this API's config and lets staging and
              production be two environments rather than two setups.
              {varNames.length > 0 && (
                <>
                  {" "}
                  Available here: {varNames.map((name) => `{{${name}}}`).join(", ")}.
                </>
              )}
            </div>

            <div className="field" style={{ marginTop: 10 }}>
              <div className="field-label">
                <div className="field-name">send credentials</div>
              </div>
              <select
                value={draft.clientAuth}
                onChange={(event) => patch({ clientAuth: event.target.value as OAuthConfig["clientAuth"] })}
              >
                <option value="body">In the request body (most providers)</option>
                <option value="basic">As Basic auth (RFC 6749 §2.3.1)</option>
              </select>
            </div>
          </section>

          <section className="section">
            <h3>Scopes</h3>
            {declaredScopes.length > 0 ? (
              <div className="scope-grid">
                {declaredScopes.map((scope) => (
                  <label className="check" key={scope.name} title={scope.description}>
                    <input
                      type="checkbox"
                      checked={draft.scopes.includes(scope.name)}
                      onChange={() => toggleScope(scope.name)}
                    />
                    <span className="mono">{scope.name}</span>
                  </label>
                ))}
              </div>
            ) : (
              <input
                value={draft.scopes.join(" ")}
                placeholder="space-separated, e.g. read:orders write:orders"
                onChange={(event) =>
                  patch({ scopes: event.target.value.split(/\s+/).filter(Boolean) })
                }
              />
            )}
          </section>

          {problems.length > 0 && (
            <div className="verdict warn">
              <span className="glyph">⚠</span>
              <span>{problems.join(" ")}</span>
            </div>
          )}
          {error && <div className="error-box">{error}</div>}

          <section className="section">
            <h3>Token</h3>
            <div className="oauth-status">
              <KeyRound size={13} className={token?.accessToken ? "ok-ink" : undefined} />
              <span className="meta">{describeExpiry(token)}</span>
              {token?.scope && <span className="meta mono">· {token.scope}</span>}
              <span className="spacer" />
              {token?.accessToken && (
                <button className="btn" onClick={onClear}>
                  Clear
                </button>
              )}
              <button
                className="btn primary"
                disabled={busy || problems.length > 0}
                onClick={() => {
                  onSave(draft);
                  onAcquire(draft);
                }}
              >
                {busy ? <Loader2 size={13} className="spin" /> : <KeyRound size={13} />}
                {draft.grant === "authorization_code" ? "Sign in" : "Get token"}
              </button>
            </div>
            <div className="field-meta" style={{ marginTop: 6 }}>
              Tokens are refreshed automatically before they expire and are never written into the
              spec, the library index, or anything you'd commit.
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
