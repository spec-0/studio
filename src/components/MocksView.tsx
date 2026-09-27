import { useState } from "react";
import { Check, Copy, Eye, EyeOff, KeyRound, Plus, RefreshCw, Server } from "lucide-react";
import type { MockRow } from "../lib/spec0";
import { maskKey } from "../lib/mockJourney";
import type { MockKeyState } from "../hooks/useMocks";

interface Props {
  signedIn: boolean;
  orgName?: string | null;
  mocks: MockRow[] | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onSignIn: () => void;
  /** Start "Create a mock server" — it asks which API. */
  onCreate: () => void;
  keys: Record<string, MockKeyState>;
  onLoadKey: (mockServerId: string) => Promise<string | null>;
  onRegenerateKey: (mockServerId: string) => void;
}

/**
 * The Mocks tab: the hosted mock servers in the signed-in organisation.
 *
 * Signed out, it explains what a hosted mock is and offers a way to sign in.
 * Nothing on this page is needed for the rest of Studio to work.
 */
export function MocksView({
  signedIn,
  orgName,
  mocks,
  loading,
  error,
  onRefresh,
  onSignIn,
  onCreate,
  keys,
  onLoadKey,
  onRegenerateKey,
}: Props) {
  const [copied, setCopied] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const copy = (value: string, tag = value) => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(tag);
      window.setTimeout(() => setCopied((prev) => (prev === tag ? null : prev)), 1400);
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
              <button className="btn primary" onClick={onCreate}>
                <Plus size={13} /> Create a mock server
              </button>
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
            <div>
              <p>No hosted mocks in {orgName ?? "your organisation"} yet.</p>
              <p className="field-meta">
                Create one from any API in your library. Studio publishes it to your organisation
                first if it isn&apos;t there yet.
              </p>
            </div>
          </div>
        )}

        {signedIn && mocks && mocks.length > 0 && (
          <table className="fields mocks-table">
            <thead>
              <tr>
                <th>API</th>
                <th>URL</th>
                <th>Spec version</th>
                <th>Key</th>
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
                  <td className="mock-key">
                    {mock.mockServerId ? (
                      <KeyCell
                        id={mock.mockServerId}
                        apiName={mock.apiName}
                        state={keys[mock.mockServerId]}
                        revealed={revealed === mock.mockServerId}
                        confirming={confirming === mock.mockServerId}
                        copied={copied === `key:${mock.mockServerId}`}
                        onReveal={async () => {
                          const id = mock.mockServerId!;
                          if (revealed === id) return setRevealed(null);
                          if ((await onLoadKey(id)) !== null) setRevealed(id);
                        }}
                        onCopy={async () => {
                          const key = await onLoadKey(mock.mockServerId!);
                          if (key) copy(key, `key:${mock.mockServerId}`);
                        }}
                        onAskRegenerate={() => setConfirming(mock.mockServerId)}
                        onCancelRegenerate={() => setConfirming(null)}
                        onRegenerate={() => {
                          setConfirming(null);
                          setRevealed(mock.mockServerId);
                          onRegenerateKey(mock.mockServerId!);
                        }}
                      />
                    ) : (
                      <span className="meta">—</span>
                    )}
                  </td>
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

/** One mock's key: masked until asked for, with copy and a confirmed regenerate. */
function KeyCell({
  apiName,
  state,
  revealed,
  confirming,
  copied,
  onReveal,
  onCopy,
  onAskRegenerate,
  onCancelRegenerate,
  onRegenerate,
}: {
  id: string;
  apiName: string;
  state: MockKeyState | undefined;
  revealed: boolean;
  confirming: boolean;
  copied: boolean;
  onReveal: () => void;
  onCopy: () => void;
  onAskRegenerate: () => void;
  onCancelRegenerate: () => void;
  onRegenerate: () => void;
}) {
  if (confirming) {
    return (
      <div className="mock-key-confirm" role="alert">
        <span>The current key stops working straight away.</span>
        <button className="btn" onClick={onRegenerate}>
          Make a new key
        </button>
        <button className="btn ghost" onClick={onCancelRegenerate}>
          Keep
        </button>
      </div>
    );
  }
  const known = state?.status === "known" ? state.key : null;
  return (
    <div className="mock-key-cell">
      <code className="meta" title={state?.status === "unavailable" ? state.message : undefined}>
        {state?.status === "loading"
          ? "…"
          : known
            ? revealed
              ? known
              : maskKey(known)
            : state?.status === "unavailable"
              ? "not available"
              : "••••••••"}
      </code>
      <button
        className="icon-btn tight"
        onClick={onReveal}
        aria-label={revealed ? `Hide the ${apiName} mock key` : `Show the ${apiName} mock key`}
        title={revealed ? "Hide key" : "Show key"}
      >
        {revealed ? <EyeOff size={13} /> : <Eye size={13} />}
      </button>
      <button
        className="icon-btn tight"
        onClick={onCopy}
        aria-label={`Copy the ${apiName} mock key`}
        title="Copy key"
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
      <button
        className="icon-btn tight"
        onClick={onAskRegenerate}
        aria-label={`Regenerate the ${apiName} mock key`}
        title="Regenerate key"
      >
        <KeyRound size={13} />
      </button>
    </div>
  );
}
