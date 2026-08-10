import { useEffect, useState } from "react";
import {
  DEFAULT_API_URL,
  DEFAULT_APP_URL,
  adoptCliSession,
  createMock,
  fetchTeamApiSpec,
  loadCatalog as fetchCatalog,
  signInViaBrowser,
  verify,
  type CatalogEntry,
  type Session,
} from "../lib/spec0";
import { Cloud, CloudOff, Download, Globe, Plus, RefreshCw, Search, TriangleAlert } from "lucide-react";
import { inTauri } from "../lib/request";

type Source = "file" | "url" | "spec0";

interface Props {
  session: Session | null;
  onSession: (session: Session | null) => void;
  onOpenFile: () => void;
  onOpenUrl: (url: string) => void;
  onOpenSpec0: (
    text: string,
    name: string,
    source: string,
    mock: {
      mockUrl: string | null;
      mockApiKey: string | null;
      mockServerId: string | null;
      mockSpecVersion: string | null;
    },
  ) => void;
  onTrySample: () => void;
  onClose: () => void;
  /** Which tab to land on — the title-bar connection chip opens straight to spec0. */
  initialSource?: Source;
}

/**
 * Where a spec comes from: a local file, a URL, or the org's spec0 catalog.
 *
 * spec0 is one source among three, never a gate — nothing here is required to use
 * the client, which is the free-tier rule the whole product rests on.
 */
export function OpenDialog({
  session,
  onSession,
  onOpenFile,
  onOpenUrl,
  onOpenSpec0,
  onTrySample,
  onClose,
  initialSource,
}: Props) {
  const [source, setSource] = useState<Source>(initialSource ?? (session ? "spec0" : "file"));
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cliAvailable, setCliAvailable] = useState(false);
  const [manualToken, setManualToken] = useState("");
  const [manualOrg, setManualOrg] = useState("");

  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  /**
   * Mock keys captured this session. The API returns a mock's key **only** at
   * creation — the list endpoint never carries it — so a key we saw once is worth
   * holding on to until the import that consumes it.
   */
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState("");

  useEffect(() => {
    if (!inTauri) return;
    void adoptCliSession().then((found) => setCliAvailable(Boolean(found)));
  }, []);

  const loadCatalog = async (active: Session) => {
    setBusy("Loading catalog…");
    setError(null);
    try {
      setCatalog(await fetchCatalog(active));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (session && source === "spec0" && !catalog.length) void loadCatalog(session);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, source]);

  const connect = async (make: () => Promise<Session | null>, label: string) => {
    setBusy(label);
    setError(null);
    try {
      const next = await make();
      if (!next) throw new Error("No session was returned.");
      await verify(next);
      onSession(next);
      await loadCatalog(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  /** Pull the spec by UUID and hand it up, carrying the mock so the import keeps it. */
  const openCatalogEntry = async (entry: CatalogEntry) => {
    if (!session) return;
    setBusy(`Pulling ${entry.apiName}…`);
    setError(null);
    try {
      const text = await fetchTeamApiSpec(session, entry.apiId);
      onOpenSpec0(text, entry.apiName, `spec0:${entry.apiId}`, {
        mockUrl: entry.mockUrl,
        mockApiKey: keys[entry.apiId] ?? null,
        mockServerId: entry.mockServerId,
        mockSpecVersion: entry.mockSpecVersion,
      });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  /** Provision a mock for an API that doesn't have one, keeping the key if we get it. */
  const provisionMock = async (entry: CatalogEntry) => {
    if (!session) return;
    setBusy(`Creating a mock for ${entry.apiName}…`);
    setError(null);
    try {
      const created = await createMock(session, entry.apiId);
      if (created.apiKey) setKeys((prev) => ({ ...prev, [entry.apiId]: created.apiKey! }));
      setCatalog((prev) =>
        prev.map((row) =>
          row.apiId === entry.apiId
            ? {
                ...row,
                mockUrl: created.mockUrl,
                mockServerId: created.mockServerId ?? null,
                mockSpecVersion: row.mockSpecVersion,
              }
            : row,
        ),
      );
      if (!created.apiKey) {
        setError(
          `Mock ready at ${created.mockUrl}. Its API key isn't returned for an existing mock — ` +
            `copy it from the spec0 dashboard and paste it into the Auth section as an ` +
            `X-Mock-API-Key header if requests come back 401.`,
        );
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  const matches = (text: string) => text.toLowerCase().includes(filter.toLowerCase());

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal wide" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <strong>Open a spec</strong>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="tabs" style={{ padding: "6px 12px 0" }}>
          {(["file", "url", "spec0"] as const).map((tab) => (
            <button
              key={tab}
              className="tab"
              role="tab"
              aria-selected={source === tab}
              onClick={() => setSource(tab)}
            >
              {tab === "file" ? "Local file" : tab === "url" ? "URL" : "spec0"}
            </button>
          ))}
        </div>

        <div className="modal-body">
          {busy && <div className="verdict none">{busy}</div>}
          {error && (
            <div className="error-box">
              <div className="error-head">
                <TriangleAlert size={13} />
                <span>Couldn&apos;t talk to spec0</span>
                <span className="spacer" />
                <button
                  className="btn"
                  style={{ padding: "1px 7px" }}
                  onClick={() => void navigator.clipboard.writeText(error)}
                >
                  Copy
                </button>
              </div>
              <pre className="error-detail">{error}</pre>
            </div>
          )}

          {source === "file" && (
            <>
              <p className="meta">Open an OpenAPI 3.0 or 3.1 document — YAML or JSON.</p>
              <button
                className="btn primary"
                style={{ marginTop: 10 }}
                onClick={() => {
                  onOpenFile();
                  onClose();
                }}
              >
                Choose file…
              </button>
              <p className="meta" style={{ marginTop: 8 }}>
                You can also drop a file anywhere on the window. Whatever you open is added to your
                library, so it&apos;s one click away next time.
              </p>

              <div className="section">
                <h3>Nothing to hand?</h3>
                <button
                  className="btn"
                  onClick={() => {
                    onTrySample();
                    onClose();
                  }}
                >
                  Add the sample API
                </button>
              </div>
            </>
          )}

          {source === "url" && (
            <>
              <p className="meta">Paste a link to a hosted OpenAPI document.</p>
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <input
                  value={url}
                  placeholder="https://example.com/openapi.yaml"
                  onChange={(event) => setUrl(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && url.trim()) {
                      onOpenUrl(url.trim());
                      onClose();
                    }
                  }}
                />
                <button
                  className="btn primary"
                  disabled={!url.trim()}
                  onClick={() => {
                    onOpenUrl(url.trim());
                    onClose();
                  }}
                >
                  Open
                </button>
              </div>
              {!inTauri && (
                <p className="meta warn" style={{ marginTop: 8 }}>
                  In the browser preview this is subject to CORS. The desktop app fetches from Rust
                  and isn&apos;t.
                </p>
              )}
            </>
          )}

          {source === "spec0" && !session && (
            <>
              {/* State the capability split explicitly. Someone on this tab is asking
                  exactly this question, so answering it here isn't a nag — and the
                  status chip must never answer it anywhere else. */}
              <div className="modes">
                <div className="mode">
                  <div className="mode-head">
                    <CloudOff size={13} />
                    <strong>Local</strong>
                    <span className="tag ok">now</span>
                  </div>
                  <ul>
                    <li>Open specs from a file, a URL, or the sample</li>
                    <li>Browse operations, schemas and the schema graph</li>
                    <li>Auth, custom headers, environments and secrets</li>
                    <li>Send requests to any host</li>
                    <li>Response validation and drift detection</li>
                    <li>Request history</li>
                  </ul>
                  <p className="meta">No account. No network call to spec0. Ever.</p>
                </div>
                <div className="mode">
                  <div className="mode-head">
                    <Cloud size={13} />
                    <strong>Connected</strong>
                    <span className="tag">adds</span>
                  </div>
                  <ul>
                    <li>Your organisation&apos;s API catalog</li>
                    <li>Import any org API, private or published</li>
                    <li>Re-pull a spec when it changes upstream</li>
                    <li>Discover and create hosted mock servers</li>
                    <li>Target a mock from the address bar</li>
                  </ul>
                  <p className="meta">Signing out reverts to Local. Nothing you added is lost.</p>
                </div>
              </div>

              <div style={{ display: "grid", gap: 8, marginTop: 14, maxWidth: 460 }}>
                {cliAvailable && (
                  <button
                    className="btn primary"
                    onClick={() => void connect(adoptCliSession, "Using your CLI session…")}
                  >
                    Use my spec0 CLI session
                  </button>
                )}
                <button
                  className="btn"
                  disabled={!inTauri}
                  onClick={() =>
                    void connect(() => signInViaBrowser(DEFAULT_APP_URL, DEFAULT_API_URL), "Waiting for the browser…")
                  }
                >
                  Sign in with a browser
                </button>
                {!inTauri && (
                  <p className="meta">Browser sign-in needs the desktop app (it holds the loopback port).</p>
                )}

                <div className="section">
                  <h3>Or paste a token</h3>
                  <div style={{ display: "grid", gap: 6 }}>
                    <input
                      placeholder="SPEC0_TOKEN"
                      type="password"
                      value={manualToken}
                      onChange={(event) => setManualToken(event.target.value)}
                    />
                    <input
                      placeholder="SPEC0_ORG_ID"
                      value={manualOrg}
                      onChange={(event) => setManualOrg(event.target.value)}
                    />
                    <button
                      className="btn"
                      disabled={!manualToken.trim() || !manualOrg.trim()}
                      onClick={() =>
                        void connect(
                          async () => ({
                            apiUrl: DEFAULT_API_URL,
                            appUrl: DEFAULT_APP_URL,
                            orgId: manualOrg.trim(),
                            orgName: "your org",
                            token: manualToken.trim(),
                            source: "manual" as const,
                            connectedAt: new Date().toISOString(),
                          }),
                          "Checking token…",
                        )
                      }
                    >
                      Connect
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}

          {source === "spec0" && session && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span className="tag ok">connected</span>
                <strong>{session.orgName}</strong>
                <span className="meta">via {session.source}</span>
                <span className="spacer" />
                <button className="btn" onClick={() => void loadCatalog(session)}>
                  <RefreshCw size={12} /> Refresh
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    onSession(null);
                    setCatalog([]);
                  }}
                >
                  Sign out
                </button>
              </div>

              <div className="library-search" style={{ marginTop: 12 }}>
                <Search size={13} />
                <input
                  style={{ width: "100%" }}
                  placeholder="Filter your APIs…"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                />
              </div>

              <div className="section">
                <h3>Your APIs · {catalog.length}</h3>
                {catalog
                  .filter((entry) => matches(`${entry.apiName} ${entry.teamName ?? ""}`))
                  .map((entry) => (
                    <button
                      key={entry.apiId}
                      className="row"
                      onClick={() => void openCatalogEntry(entry)}
                    >
                      <Download size={13} className="row-lead" />
                      <span style={{ minWidth: 0, display: "grid", flex: 1 }}>
                        <span className="path">{entry.apiName}</span>
                        <span className="summary">
                          {entry.teamName ?? "—"}
                          {entry.description ? ` · ${entry.description}` : ""}
                        </span>
                      </span>
                      {entry.mockUrl ? (
                        <span className="tag mock">mock</span>
                      ) : (
                        <span
                          className="tag add-mock"
                          role="button"
                          tabIndex={0}
                          title="Create a mock server for this API"
                          onClick={(event) => {
                            event.stopPropagation();
                            void provisionMock(entry);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.stopPropagation();
                              void provisionMock(entry);
                            }
                          }}
                        >
                          <Plus size={10} />
                          mock
                        </span>
                      )}
                      {entry.isPublic && (
                        <span className="tag src-spec0" title="Also published to the public registry">
                          <Globe size={11} />
                          public
                        </span>
                      )}
                      {entry.version && <span className="count">{entry.version}</span>}
                    </button>
                  ))}
                {catalog.length === 0 && !busy && (
                  <p className="meta">
                    No APIs in this org yet — <code>spec0 push</code> puts one here.
                  </p>
                )}
              </div>

              <p className="meta" style={{ marginTop: 14 }}>
                Every API opens by its id, so private ones work the same as published ones. An API
                with a mock imports with it attached — switch between the real servers and the mock
                from the address bar.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
