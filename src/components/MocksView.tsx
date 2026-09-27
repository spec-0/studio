import { useState } from "react";
import { Check, Copy, Plus, RefreshCw, Server } from "lucide-react";
import type { MockRow } from "../lib/spec0";

interface Props {
  signedIn: boolean;
  orgName?: string | null;
  mocks: MockRow[] | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onSignIn: () => void;
}

/**
 * The Mocks tab: the hosted mock servers in the signed-in organisation.
 *
 * Signed out, it explains what a hosted mock is and offers a way to sign in.
 * Nothing on this page is needed for the rest of Studio to work.
 */
export function MocksView({ signedIn, orgName, mocks, loading, error, onRefresh, onSignIn }: Props) {
  const [copied, setCopied] = useState<string | null>(null);

  const copy = (url: string) => {
    void navigator.clipboard?.writeText(url).then(() => {
      setCopied(url);
      window.setTimeout(() => setCopied((prev) => (prev === url ? null : prev)), 1400);
    });
  };

  return (
    <div className="page">
      <div className="page-inner">
        <div className="library-head">
          <div>
            <h1>Mocks</h1>
            <p className="page-sub">
              Hosted mock servers answer with examples from the spec, so you can call an API before
              it exists.
            </p>
          </div>
          <span className="spacer" />
          {signedIn && (
            <>
              <button className="btn" onClick={onRefresh} disabled={loading}>
                <RefreshCw size={12} className={loading ? "spin" : undefined} /> Refresh
              </button>
              <span title="Coming soon">
                <button className="btn primary" disabled aria-disabled>
                  <Plus size={13} /> Create a mock server
                </button>
              </span>
            </>
          )}
        </div>

        {!signedIn && (
          <div className="placeholder-card">
            <Server size={18} aria-hidden />
            <div>
              <p>Hosted mocks come with a Spec0 account.</p>
              <p className="field-meta">
                Sign in to see your organisation&apos;s mock servers here. An API you open from Spec0
                comes with its mock attached, and you can pick it as a target in the address bar.
                Everything else in Studio works without signing in.
              </p>
              <button className="btn primary" style={{ marginTop: 10 }} onClick={onSignIn}>
                Sign in to Spec0…
              </button>
            </div>
          </div>
        )}

        {signedIn && error && (
          <div className="error-box">
            Couldn&apos;t load mocks from Spec0.
            <pre className="error-detail">{error}</pre>
          </div>
        )}

        {signedIn && !error && mocks && mocks.length === 0 && (
          <div className="placeholder-card">
            <Server size={18} aria-hidden />
            <p>No hosted mocks in {orgName ?? "your organisation"} yet.</p>
          </div>
        )}

        {signedIn && mocks && mocks.length > 0 && (
          <table className="fields mocks-table">
            <thead>
              <tr>
                <th>API</th>
                <th>URL</th>
                <th>Spec version</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {mocks.map((mock) => (
                <tr key={mock.key}>
                  <td className="mock-api">
                    <strong>{mock.apiName}</strong>
                    {mock.name && <div className="field-meta">{mock.name}</div>}
                  </td>
                  <td className="name mock-url">{mock.url}</td>
                  <td className="meta">{mock.specVersion ?? "—"}</td>
                  <td className="mock-actions">
                    <button
                      className="icon-btn"
                      onClick={() => copy(mock.url)}
                      aria-label={`Copy the URL of the ${mock.apiName} mock`}
                      title="Copy URL"
                    >
                      {copied === mock.url ? <Check size={14} /> : <Copy size={14} />}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {signedIn && loading && !mocks && <p className="meta">Loading mocks…</p>}
      </div>
    </div>
  );
}
