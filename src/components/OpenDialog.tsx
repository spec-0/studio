import { useEffect, useState } from "react";
import {
  DEFAULT_API_URL,
  DEFAULT_APP_URL,
  adoptCliSession,
  createMock,
  fetchTeamApiSpec,
  getMockApiKey,
  loadCatalog as fetchCatalog,
  SignInCancelled,
  signInViaBrowser,
  verify,
  type CatalogEntry,
  type Session,
} from "../lib/spec0";
import { ConnectModes } from "./ConnectModes";
import { Download, Globe, Plus, RefreshCw, Search, TriangleAlert } from "lucide-react";
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
  /** What the last create did, shown until the next action. */
  const [created, setCreated] = useState<string | null>(null);
  /** A neutral note, such as a cancelled sign-in. */
  const [notice, setNotice] = useState<string | null>(null);

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
    setCreated(null);
    setNotice(null);
    try {
      const next = await make();
      if (!next) throw new Error("No session was returned.");
      await verify(next);
      onSession(next);
      await loadCatalog(next);
    } catch (caught) {
      // Pressing Cancel on the sign-in page is a choice, not a failure.
      if (caught instanceof SignInCancelled) setNotice("Sign-in cancelled.");
      else setError(caught instanceof Error ? caught.message : String(caught));
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
    setCreated(null);
    try {
      const created = await createMock(session, entry.apiId);
      // An existing mock doesn't return its key on create; ask for it.
      const apiKey =
        created.apiKey ??
        (created.mockServerId
          ? ((await getMockApiKey(session, created.mockServerId).catch(() => null))?.apiKey ?? null)
          : null);
      if (apiKey) setKeys((prev) => ({ ...prev, [entry.apiId]: apiKey }));
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
      setCreated(
        apiKey
          ? `Mock ready at ${created.mockUrl}. Its key is saved and used when you open ${entry.apiName}.`
          : `Mock ready at ${created.mockUrl}. Spec0 didn't return its key; Studio asks for it when you send a request to the mock.`,
      );
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
          {notice && !busy && (
            <p className="meta" role="status">
              {notice}
            </p>
          )}
          {created && !busy && (
            <div className="verdict ok" role="status">
              <span className="glyph">✓</span>
              <span>{created}</span>
            </div>
          )}
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
              <ConnectModes />

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
                      {entry.mockUrl && <span className="tag mock">mock</span>}
                      {entry.isPublic && (
                        <span className="tag src-spec0" title="Also published to the public registry">
                          <Globe size={11} />
                          public
                        </span>
                      )}
                      {entry.version && <span className="count">{entry.version}</span>}
                      {!entry.mockUrl && (
                        /* An action, so it looks like one: a real button, at the
                           end of the row, not a tag where the "mock" tag goes. */
                        <span
                          className="btn row-action"
                          role="button"
                          tabIndex={0}
                          title="Create a hosted mock server for this API"
                          onClick={(event) => {
                            event.stopPropagation();
                            void provisionMock(entry);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              event.stopPropagation();
                              void provisionMock(entry);
                            }
                          }}
                        >
                          <Plus size={11} /> Create mock
                        </span>
                      )}
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
