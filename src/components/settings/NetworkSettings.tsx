import { useEffect, useState } from "react";
import { Cookie, ShieldAlert, ShieldCheck, Trash2 } from "lucide-react";
import {
  DEFAULT_TIMEOUT_MS,
  withTrust,
  withoutTrust,
  type ConnectionSettings,
  type HostTrust,
} from "../../lib/connection";
import { clearCookies, listCookies, type StoredCookie } from "../../lib/cookies";
import { pickCertificate } from "../../lib/store";

interface Props {
  settings: ConnectionSettings;
  onSave: (next: ConnectionSettings) => void;
  /** The API whose cookie jar this is. Absent when no API is open. */
  jar: { id: string; title: string } | null;
  /** Pre-fill the trust form with the host you were just trying to reach. */
  suggestHost?: string | null;
}

/**
 * Network settings: certificate trust, proxy, timeout, redirects, cookies.
 *
 * Grouped into one section because they answer a single question — "why can't
 * this thing reach my server" — and someone debugging that shouldn't have to
 * guess which of four places to look.
 */
export function NetworkSettings({ settings, onSave, jar, suggestHost }: Props) {
  const [draft, setDraft] = useState<ConnectionSettings>(settings);
  const [host, setHost] = useState(suggestHost ?? "");
  const [pem, setPem] = useState<{ name: string; content: string } | null>(null);
  const [cookies, setCookies] = useState<StoredCookie[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (jar) void listCookies(jar.id).then(setCookies);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jar?.id]);

  // Settings loaded after this mounted (at start, say) replace the draft.
  useEffect(() => setDraft(settings), [settings]);
  useEffect(() => {
    if (suggestHost) setHost(suggestHost);
  }, [suggestHost]);

  const commit = (next: ConnectionSettings) => {
    setDraft(next);
    onSave(next);
  };

  const addTrust = (insecure: boolean) => {
    const name = host.trim();
    if (!name) {
      setError("Enter the hostname this applies to.");
      return;
    }
    if (!insecure && !pem) {
      setError("Choose a CA bundle, or use “Skip verification” if you don't have one.");
      return;
    }
    const trust: HostTrust = {
      host: name,
      insecure,
      caBundlePem: insecure ? undefined : pem?.content,
      caBundleName: insecure ? undefined : pem?.name,
    };
    commit(withTrust(draft, trust));
    setHost("");
    setPem(null);
    setError(null);
  };

  return (
    <>
          <section className="section">
            <h3>Certificates</h3>
            <p className="field-meta">
              Internal services often sit behind a private CA. Adding its bundle keeps verification
              on. Skipping verification turns it off for that host only — never globally, and the
              address bar says so on every request that uses it.
            </p>

            {draft.trusted.length > 0 && (
              <div className="trust-list">
                {draft.trusted.map((entry) => (
                  <div className="trust-row" key={entry.host}>
                    {entry.insecure ? (
                      <ShieldAlert size={13} className="danger-ink" />
                    ) : (
                      <ShieldCheck size={13} className="ok-ink" />
                    )}
                    <span className="mono">{entry.host}</span>
                    <span className="meta">
                      {entry.insecure ? "verification off" : `CA: ${entry.caBundleName ?? "bundle"}`}
                    </span>
                    <span className="spacer" />
                    <button
                      className="icon-btn tight danger"
                      aria-label={`Remove ${entry.host}`}
                      onClick={() => commit(withoutTrust(draft, entry.host))}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="field" style={{ marginTop: 10 }}>
              <div className="field-label">
                <input
                  value={host}
                  placeholder="api.internal.example.com"
                  onChange={(event) => setHost(event.target.value)}
                />
              </div>
              <div style={{ flex: 1, display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button
                  className="btn"
                  onClick={async () => {
                    const picked = await pickCertificate();
                    if (picked) setPem({ name: picked.name, content: picked.text });
                  }}
                >
                  {pem ? `✓ ${pem.name}` : "Choose CA bundle…"}
                </button>
                <button className="btn primary" onClick={() => addTrust(false)}>
                  Trust with CA
                </button>
                <button className="btn danger-outline" onClick={() => addTrust(true)}>
                  Skip verification
                </button>
              </div>
            </div>
            {error && <div className="error-box">{error}</div>}
          </section>

          <section className="section">
            <h3>Proxy</h3>
            <p className="field-meta">
              By default Studio honours <span className="mono">HTTPS_PROXY</span>,{" "}
              <span className="mono">HTTP_PROXY</span> and <span className="mono">NO_PROXY</span> from
              your environment, the same as every other tool on this machine.
            </p>
            <div className="field">
              <div className="field-label">
                <div className="field-name">proxy URL</div>
              </div>
              <input
                value={draft.proxy.url ?? ""}
                placeholder="http://proxy.corp:3128 — blank to use the environment"
                disabled={draft.proxy.disabled}
                onChange={(event) =>
                  commit({ ...draft, proxy: { ...draft.proxy, url: event.target.value } })
                }
              />
            </div>
            <div className="field">
              <div className="field-label">
                <div className="field-name">bypass</div>
              </div>
              <input
                value={draft.proxy.noProxy ?? ""}
                placeholder="localhost,127.0.0.1,.internal"
                disabled={draft.proxy.disabled || !draft.proxy.url}
                onChange={(event) =>
                  commit({ ...draft, proxy: { ...draft.proxy, noProxy: event.target.value } })
                }
              />
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={draft.proxy.disabled ?? false}
                onChange={(event) =>
                  commit({ ...draft, proxy: { ...draft.proxy, disabled: event.target.checked } })
                }
              />
              Never use a proxy, including the environment's
            </label>
          </section>

          <section className="section">
            <h3>Requests</h3>
            <div className="field">
              <div className="field-label">
                <div className="field-name">timeout</div>
                <div className="field-meta">seconds</div>
              </div>
              <input
                type="number"
                min={1}
                max={600}
                value={Math.round(draft.timeoutMs / 1000)}
                onChange={(event) => {
                  const seconds = Number(event.target.value);
                  commit({
                    ...draft,
                    timeoutMs:
                      Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_TIMEOUT_MS,
                  });
                }}
              />
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={draft.followRedirects}
                onChange={(event) => commit({ ...draft, followRedirects: event.target.checked })}
              />
              Follow redirects (up to 10)
            </label>
          </section>

          {jar && (
            <section className="section">
              <h3>
                <Cookie size={12} style={{ verticalAlign: "-1px", marginRight: 6 }} />
                Cookies · {jar.title}
              </h3>
              <p className="field-meta">
                Kept per API, so a session from one never reaches another. Not written to disk — they
                last as long as the app is open.
              </p>
              {cookies.length === 0 ? (
                <div className="field-meta">No cookies held for this API.</div>
              ) : (
                <>
                  <table className="fields" style={{ marginTop: 6 }}>
                    <tbody>
                      {cookies.map((cookie) => (
                        <tr key={`${cookie.domain}${cookie.path}${cookie.name}`}>
                          <td className="name">{cookie.name}</td>
                          <td className="type">
                            {cookie.domain}
                            {cookie.path}
                          </td>
                          <td className="desc">
                            {cookie.expires ? "expires" : "session"}
                            {cookie.secure ? " · secure" : ""}
                            {cookie.httpOnly ? " · httpOnly" : ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <button
                    className="btn"
                    style={{ marginTop: 8 }}
                    onClick={async () => {
                      await clearCookies(jar.id);
                      setCookies(await listCookies(jar.id));
                    }}
                  >
                    Clear cookies
                  </button>
                </>
              )}
            </section>
          )}
          {!jar && (
            <section className="section">
              <h3>
                <Cookie size={12} style={{ verticalAlign: "-1px", marginRight: 6 }} />
                Cookies
              </h3>
              <p className="field-meta">
                Kept per API, so a session from one never reaches another. Not written to disk — they
                last as long as the app is open. Open an API to see and clear its cookies.
              </p>
            </section>
          )}
    </>
  );
}
