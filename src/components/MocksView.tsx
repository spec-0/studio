import { useState } from "react";
import { Check, Copy, Eye, EyeOff, KeyRound, Laptop, Plus, RefreshCw, Server, Square } from "lucide-react";
import type { LibraryEntry } from "../lib/library";
import type { InvalidRequests } from "../lib/localMock";
import { localMockUrl } from "../lib/localMockServer";
import { KEY_NEEDS_REGENERATING, type MockRow } from "../lib/spec0";
import { maskKey } from "../lib/mockJourney";
import type { MockKeyState } from "../hooks/useMocks";
import { EmptyState } from "./EmptyState";
import { CodeBlock } from "./CodeBlock";

interface Props {
  signedIn: boolean;
  orgName?: string | null;
  mocks: MockRow[] | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onSignIn: () => void;
  /** Start "Create a mock server"; it asks which API. */
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
      <div className="page-in">
        <div className="page-head">
          <div className="l">
            <h1 className="page-title">Mocks</h1>
            <p className="desc">A mock answers with example data from the spec, so you can call an API before it exists.</p>
          </div>
        </div>

        <LocalMocks {...local} copied={copied} onCopy={copy} />

        <div className="section-head">
          <div className="l">
            <h2 className="h2">Hosted on Spec0</h2>
            <span className="meta">Mock servers with an address you can share with your team.</span>
          </div>
          {signedIn && (
            <div className="btn-row">
              <button className="btn ghost" onClick={onRefresh} disabled={loading}>
                <RefreshCw size={12} className={loading ? "spin" : undefined} /> Refresh
              </button>
              <button className="btn" onClick={onCreate}>
                <Plus size={13} /> Create hosted mock
              </button>
            </div>
          )}
        </div>

        {!signedIn && (
          <div className="rows">
            <EmptyState
              icon={<Server size={18} />}
              title="Hosted mocks come with a Spec0 account"
              body="Sign in to see your organisation's mock servers here. Everything else in Studio works without signing in."
              action={
                <button className="btn" onClick={onSignIn}>
                  Sign in to Spec0…
                </button>
              }
            />
          </div>
        )}

        {signedIn && error && (
          <div className="error-box">
            Couldn&apos;t load mocks from Spec0.
            <pre className="error-detail">{error}</pre>
          </div>
        )}

        {signedIn && !error && mocks && mocks.length === 0 && (
          <div className="rows">
            <EmptyState
              icon={<Server size={18} />}
              title={`No hosted mocks in ${orgName ?? "your organisation"} yet`}
              body="Create one from any API in your library. Studio publishes it to your organisation first if it isn't there yet."
            />
          </div>
        )}

        {signedIn && mocks && mocks.length > 0 && (
          <table className="tbl mocks-table">
            <thead>
              <tr>
                <th>API</th>
                <th>Address</th>
                <th>Spec</th>
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
                  <td className="mono mock-url" title={mock.url}>
                    {middleTruncate(mock.url)}
                  </td>
                  <td className="meta mono">{mock.specVersion ?? "–"}</td>
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
                      <span className="meta">–</span>
                    )}
                  </td>
                  <td className="act">
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
      <div className="section-head">
        <div className="l">
          <h2 className="h2" id="local-mocks-title">On this computer</h2>
          <span className="meta">
            Serves an API from your library on 127.0.0.1, for this computer only. It runs until you stop it or quit
            Studio, and nothing starts by itself.
          </span>
        </div>
      </div>

      {!available ? (
        <EmptyState
          icon={<Server size={18} />}
          title="Local mocks need the desktop app"
          body="The browser preview can't listen for requests. Run Studio as an app to start a mock on this computer."
        />
      ) : (
        <>
          <table className="tbl mocks-table">
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
                          <span className="dot live" aria-hidden />
                          <strong>{entry.title}</strong>
                        </span>
                      </td>
                      <td className="mono">{url}</td>
                      <td className="act">
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
                {live.length === 0 && (
                  <tr>
                    <td colSpan={3} className="meta">
                      Nothing running.
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3}>
                    {entries.length === 0 ? (
                      <span className="meta">Add an API to your library to serve a mock of it here.</span>
                    ) : idle.length > 0 ? (
                      <div className="local-mock-start">
                        <label className="meta" htmlFor="local-mock-api">
                          Start a mock of
                        </label>
                        <select
                          id="local-mock-api"
                          className="select"
                          value={choice?.id ?? ""}
                          onChange={(event) => setPicked(event.target.value)}
                        >
                          {idle.map((entry) => (
                            <option key={entry.id} value={entry.id}>
                              {entry.title}
                            </option>
                          ))}
                        </select>
                        <button
                          className="btn sm"
                          disabled={!choice || busy !== null}
                          onClick={() => choice && onStart(choice)}
                        >
                          <Laptop size={13} /> Start
                        </button>
                      </div>
                    ) : (
                      <span className="meta">Every API in your library has a mock running.</span>
                    )}
                  </td>
                </tr>
              </tfoot>
            </table>

          {error && (
            <div className="error-box" role="alert">
              {error.message}
            </div>
          )}

          <div className="rows local-mock-rules">
            <div className="row-s">
              <div className="l">
                <b>When a request doesn&apos;t match the spec</b>
                <span className="meta">
                  Answer anyway and list the problems in the <span className="mono">X-Spec0-Mock-Warnings</span> header,
                  or answer <span className="mono">400</span> with them.
                </span>
              </div>
              <div className="c">
                <span className="segmented sm" role="radiogroup" aria-label="When a request doesn't match the spec">
                  <button
                    type="button"
                    role="radio"
                    className="segment"
                    aria-checked={invalid === "warn"}
                    onClick={() => onInvalid("warn")}
                  >
                    Answer and warn
                  </button>
                  <button
                    type="button"
                    role="radio"
                    className="segment"
                    aria-checked={invalid === "reject"}
                    onClick={() => onInvalid("reject")}
                  >
                    Answer 400
                  </button>
                </span>
              </div>
            </div>
            <details className="row-s stack local-mock-help">
              <summary>
                <b>Asking for a specific response</b>
                <span className="meta">
                  {" "}
                  Each operation answers with the lowest 2xx the spec declares. Web pages on localhost can call it;
                  other websites can&apos;t.
                </span>
              </summary>
              <CodeBlock
                syntax="plain"
                text={[
                  "Prefer: code=404          # another status the spec declares",
                  "X-Mock-Status: 404        # the same, as a header",
                  "GET /orders?__status=404  # the same, in the URL",
                  "Prefer: example=refunded  # a named example",
                ].join("\n")}
              />
            </details>
          </div>
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
  if (state?.status === "needsNewKey") {
    return (
      <div className="mock-key-confirm" role="status">
        <span title={KEY_NEEDS_REGENERATING}>Spec0 can&apos;t show this key again.</span>
        <button className="btn" onClick={onAskRegenerate}>
          Make a new key
        </button>
      </div>
    );
  }
  const known = state?.status === "known" ? state.key : null;
  return (
    <div className="mock-key-cell">
      <code className="meta mono" title={state?.status === "unavailable" ? state.message : undefined}>
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

/** A long address with its middle elided, so the host and the id's end both show. */
function middleTruncate(url: string, max = 64): string {
  if (url.length <= max) return url;
  const keep = Math.floor((max - 1) / 2);
  return `${url.slice(0, keep)}…${url.slice(-keep)}`;
}
