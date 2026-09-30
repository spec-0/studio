import { useState } from "react";
import { Check, Copy, Eye, EyeOff, KeyRound, Laptop, Plus, RefreshCw, Server, Square } from "lucide-react";
import type { LibraryEntry } from "../lib/library";
import type { InvalidRequests } from "../lib/localMock";
import { localMockUrl } from "../lib/localMockServer";
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
  /** Mocks on this computer. Work signed out; need the desktop app. */
  local: LocalMocksProps;
}

export interface LocalMocksProps {
  available: boolean;
  entries: LibraryEntry[];
  /** Library id → port. */
  running: Record<string, number>;
  busy: string | null;
  error: { id: string; message: string } | null;
  invalid: InvalidRequests;
  onInvalid: (invalid: InvalidRequests) => void;
  onStart: (entry: LibraryEntry) => void;
  onStop: (id: string) => void;
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
  local,
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
              A mock answers with example data from the spec, so you can call an API before it exists.
            </p>
          </div>
        </div>

        <LocalMocks {...local} copied={copied} onCopy={copy} />

        <div className="mocks-section-head">
          <div>
            <h2>Hosted</h2>
            <p className="field-meta">Mock servers on Spec0, with an address you can share with your team.</p>
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

/** "On this computer": running local mocks, a way to start one, and how they answer. */
function LocalMocks({
  available,
  entries,
  running,
  busy,
  error,
  invalid,
  onInvalid,
  onStart,
  onStop,
  copied,
  onCopy,
}: LocalMocksProps & { copied: string | null; onCopy: (value: string) => void }) {
  const idle = entries.filter((entry) => running[entry.id] === undefined);
  const [picked, setPicked] = useState("");
  const choice = idle.find((entry) => entry.id === picked) ?? idle[0];
  const live = entries.filter((entry) => running[entry.id] !== undefined);

  return (
    <section className="local-mocks" aria-labelledby="local-mocks-title">
      <div className="mocks-section-head">
        <div>
          <h2 id="local-mocks-title">On this computer</h2>
          <p className="field-meta">
            Serves an API from your library on 127.0.0.1, for this computer only. No account needed. It runs until you
            stop it or quit Studio, and nothing starts by itself.
          </p>
        </div>
      </div>

      {!available ? (
        <p className="meta">Local mocks need the desktop app.</p>
      ) : (
        <>
          {live.length > 0 && (
            <table className="fields mocks-table">
              <thead>
                <tr>
                  <th>API</th>
                  <th>Address</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {live.map((entry) => {
                  const url = localMockUrl(running[entry.id]);
                  return (
                    <tr key={entry.id}>
                      <td className="mock-api">
                        <span className="local-mock-name">
                          <span className="live-dot" aria-hidden />
                          <strong>{entry.title}</strong>
                        </span>
                      </td>
                      <td className="name mock-url">{url}</td>
                      <td className="mock-actions local">
                        <div className="local-mock-row-actions">
                          <button
                            className="icon-btn"
                            onClick={() => onCopy(url)}
                            aria-label={`Copy the address of the ${entry.title} local mock`}
                            title="Copy address"
                          >
                            {copied === url ? <Check size={14} /> : <Copy size={14} />}
                          </button>
                          <button
                            className="icon-btn"
                            onClick={() => onStop(entry.id)}
                            disabled={busy === entry.id}
                            aria-label={`Stop the ${entry.title} local mock`}
                            title="Stop"
                          >
                            <Square size={13} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {entries.length === 0 ? (
            <p className="meta">Add an API to your library to serve a mock of it here.</p>
          ) : idle.length > 0 ? (
            <div className="local-mock-start">
              <label className="field-meta" htmlFor="local-mock-api">
                Start a local mock of
              </label>
              <select id="local-mock-api" value={choice?.id ?? ""} onChange={(event) => setPicked(event.target.value)}>
                {idle.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.title}
                  </option>
                ))}
              </select>
              <button className="btn" disabled={!choice || busy !== null} onClick={() => choice && onStart(choice)}>
                <Laptop size={13} /> Start
              </button>
            </div>
          ) : null}
          {error && (
            <div className="error-box" role="alert">
              {error.message}
            </div>
          )}

          <fieldset className="local-mock-rules">
            <legend className="field-meta">When a request doesn&apos;t match the spec</legend>
            <label className="check">
              <input type="radio" name="local-mock-invalid" checked={invalid === "warn"} onChange={() => onInvalid("warn")} />
              <span>
                Answer anyway, and list the problems in the <code>X-Spec0-Mock-Warnings</code> header
              </span>
            </label>
            <label className="check">
              <input
                type="radio"
                name="local-mock-invalid"
                checked={invalid === "reject"}
                onChange={() => onInvalid("reject")}
              />
              <span>
                Answer <code>400</code> with the problems
              </span>
            </label>
          </fieldset>
          <p className="field-meta local-mock-help">
            Each operation answers with the lowest 2xx response the spec declares. Ask for another with{" "}
            <code>Prefer: code=404</code>, <code>X-Mock-Status: 404</code> or <code>?__status=404</code>, and for a named
            example with <code>Prefer: example=name</code>. Web pages served from localhost can call a local mock; other
            websites can&apos;t.
          </p>
        </>
      )}
    </section>
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
