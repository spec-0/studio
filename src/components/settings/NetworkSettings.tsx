import { useEffect, useState } from "react";
import { Cookie, Plus, ShieldAlert, ShieldCheck, Trash2 } from "lucide-react";
import {
  DEFAULT_TIMEOUT_MS,
  withTrust,
  withoutTrust,
  type ConnectionSettings,
  type HostTrust,
} from "../../lib/connection";
import { clearCookies, listCookies, type StoredCookie } from "../../lib/cookies";
import { pickCertificate } from "../../lib/store";
import { plural } from "../../lib/plural";

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
 * Grouped into one section because they answer a single question ("why can't
 * this thing reach my server?"), and someone debugging that shouldn't have to
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
      <div className="section-head">
        <div className="l">
          <h2 className="h2">Certificates</h2>
          <span className="meta">
            For a host behind a private CA, add its bundle and verification stays on. Skipping verification turns it
            off for that host only, never globally, and the address bar says so on every request that uses it.
          </span>
        </div>
      </div>
      <table className="tbl trust-table">
        <thead>
          <tr>
            <th>Host</th>
            <th>Trust</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {draft.trusted.map((entry) => (
            <tr key={entry.host}>
              <td className="mono">{entry.host}</td>
              <td>
                {entry.insecure ? (
                  <span className="chip sans warn">
                    <ShieldAlert size={11} aria-hidden /> Verification skipped
                  </span>
                ) : (
                  <span className="trust-ca">
                    <ShieldCheck size={13} className="ok-ink" aria-hidden /> Private CA{" "}
                    <span className="mono">{entry.caBundleName ?? "bundle"}</span>
                  </span>
                )}
              </td>
              <td className="act">
                <button
                  className="icon-btn danger hover-only"
                  aria-label={`Remove ${entry.host}`}
                  title="Remove"
                  onClick={() => commit(withoutTrust(draft, entry.host))}
                >
                  <Trash2 size={13} />
                </button>
              </td>
            </tr>
          ))}
          {draft.trusted.length === 0 && (
            <tr>
              <td colSpan={3} className="meta">
                Every host is verified against the system&apos;s certificates.
              </td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={3}>
              <div className="trust-add">
                <input
                  className="input mono"
                  value={host}
                  placeholder="api.internal.example.com"
                  aria-label="Host"
                  onChange={(event) => setHost(event.target.value)}
                />
                <button
                  className="btn sm"
                  onClick={async () => {
                    const picked = await pickCertificate();
                    if (picked) setPem({ name: picked.name, content: picked.text });
                  }}
                >
                  {pem ? `✓ ${pem.name}` : "Choose CA bundle…"}
                </button>
                <button className="btn sm" onClick={() => addTrust(false)}>
                  <Plus size={12} /> Trust with CA
                </button>
                <button className="btn sm danger-outline" onClick={() => addTrust(true)}>
                  Skip verification
                </button>
              </div>
            </td>
          </tr>
        </tfoot>
      </table>
      {error && <div className="error-box">{error}</div>}

      <div className="section-head">
        <div className="l">
          <h2 className="h2">Proxy</h2>
          <span className="meta">
            By default Studio uses <span className="mono">HTTPS_PROXY</span>, <span className="mono">HTTP_PROXY</span>{" "}
            and <span className="mono">NO_PROXY</span> from your environment, like every other tool on this computer.
          </span>
        </div>
      </div>
      <div className="rows">
        <div className="row-s">
          <div className="l">
            <b>Proxy URL</b>
            <span className="meta">Blank to use the environment&apos;s.</span>
          </div>
          <div className="c">
            <input
              className="input mono"
              value={draft.proxy.url ?? ""}
              placeholder="http://proxy.corp:3128"
              aria-label="Proxy URL"
              disabled={draft.proxy.disabled}
              onChange={(event) => commit({ ...draft, proxy: { ...draft.proxy, url: event.target.value } })}
            />
          </div>
        </div>
        <div className="row-s">
          <div className="l">
            <b>Bypass</b>
            <span className="meta">Hosts that skip the proxy, separated by commas.</span>
          </div>
          <div className="c">
            <input
              className="input mono"
              value={draft.proxy.noProxy ?? ""}
              placeholder="localhost,127.0.0.1,.internal"
              aria-label="Hosts that bypass the proxy"
              disabled={draft.proxy.disabled || !draft.proxy.url}
              onChange={(event) => commit({ ...draft, proxy: { ...draft.proxy, noProxy: event.target.value } })}
            />
          </div>
        </div>
        <div className="row-s">
          <div className="l">
            <b>Never use a proxy</b>
            <span className="meta">Including the environment&apos;s.</span>
          </div>
          <div className="c">
            <input
              type="checkbox"
              className="switch"
              role="switch"
              aria-label="Never use a proxy"
              checked={draft.proxy.disabled ?? false}
              onChange={(event) => commit({ ...draft, proxy: { ...draft.proxy, disabled: event.target.checked } })}
            />
          </div>
        </div>
      </div>

      <div className="section-head">
        <div className="l">
          <h2 className="h2">Requests</h2>
        </div>
      </div>
      <div className="rows">
        <div className="row-s">
          <div className="l">
            <b>Timeout</b>
            <span className="meta">In seconds.</span>
          </div>
          <div className="c">
            <input
              className="input mono timeout-input"
              type="number"
              min={1}
              max={600}
              aria-label="Timeout in seconds"
              value={Math.round(draft.timeoutMs / 1000)}
              onChange={(event) => {
                const seconds = Number(event.target.value);
                commit({
                  ...draft,
                  timeoutMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_TIMEOUT_MS,
                });
              }}
            />
          </div>
        </div>
        <div className="row-s">
          <div className="l">
            <b>Follow redirects</b>
            <span className="meta">Up to 10. The response says which ones were followed.</span>
          </div>
          <div className="c">
            <input
              type="checkbox"
              className="switch"
              role="switch"
              aria-label="Follow redirects"
              checked={draft.followRedirects}
              onChange={(event) => commit({ ...draft, followRedirects: event.target.checked })}
            />
          </div>
        </div>
        <div className="row-s">
          <div className="l">
            <b>
              <Cookie size={12} style={{ verticalAlign: "-1px", marginRight: 6 }} aria-hidden />
              Cookies{jar ? ` · ${jar.title}` : ""}
            </b>
            <span className="meta">
              Kept per API, so a session from one never reaches another, and only while Studio is open.
              {jar ? ` ${plural(cookies.length, "cookie")} held.` : " Open an API to see and clear its cookies."}
            </span>
          </div>
          {jar && cookies.length > 0 && (
            <div className="c">
              <button
                className="btn sm"
                onClick={async () => {
                  await clearCookies(jar.id);
                  setCookies(await listCookies(jar.id));
                }}
              >
                Clear cookies
              </button>
            </div>
          )}
        </div>
        {jar && cookies.length > 0 && (
          <div className="row-s stack">
            <table className="tbl">
              <tbody>
                {cookies.map((cookie) => (
                  <tr key={`${cookie.domain}${cookie.path}${cookie.name}`}>
                    <td className="mono">{cookie.name}</td>
                    <td className="mono">
                      {cookie.domain}
                      {cookie.path}
                    </td>
                    <td className="meta">
                      {cookie.expires ? "expires" : "session"}
                      {cookie.secure ? " · secure" : ""}
                      {cookie.httpOnly ? " · httpOnly" : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
