import { useCallback, useMemo, useState } from "react";
import { ApiBar, API_PANEL_ID } from "./components/ApiBar";
import { ApiSwitcher } from "./components/ApiSwitcher";
import { DocumentView } from "./components/DocumentView";
import { EnvironmentsDialog } from "./components/EnvironmentsDialog";
import { GraphView } from "./components/GraphView";
import { CopiedNote, HistoryDetail } from "./components/HistoryDetail";
import { HistoryView } from "./components/HistoryView";
import { Inspector } from "./components/Inspector";
import { Library } from "./components/Library";
import { McpView } from "./components/McpView";
import { MockKeyBar } from "./components/MockKeyBar";
import { MocksView } from "./components/MocksView";
import { OAuthDialog } from "./components/OAuthDialog";
import { OpenDialog } from "./components/OpenDialog";
import { OperationView } from "./components/OperationView";
import { PublishDialog } from "./components/PublishDialog";
import { RunDialog } from "./components/RunDialog";
import { SchemaView } from "./components/SchemaView";
import { ScratchView } from "./components/ScratchView";
import { AccountSettings } from "./components/settings/AccountSettings";
import { AppearanceSettings } from "./components/settings/AppearanceSettings";
import { DataSettings } from "./components/settings/DataSettings";
import { McpSettings } from "./components/settings/McpSettings";
import { NetworkSettings } from "./components/settings/NetworkSettings";
import { UpdateSettings } from "./components/settings/UpdateSettings";
import { SettingsView } from "./components/SettingsView";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { TitleBar } from "./components/TitleBar";
import { UpdateDialog } from "./components/UpdateDialog";
import { UrlBar } from "./components/UrlBar";
import { useBoot } from "./hooks/useBoot";
import { useBulkRun } from "./hooks/useBulkRun";
import { useConnectionSettings } from "./hooks/useConnectionSettings";
import { useDialogs } from "./hooks/useDialogs";
import { useDocumentFacts } from "./hooks/useDocumentFacts";
import { useEnvironments } from "./hooks/useEnvironments";
import { useHistoryRecords } from "./hooks/useHistoryRecords";
import { useLibrary } from "./hooks/useLibrary";
import { useMocks } from "./hooks/useMocks";
import { useNavigation } from "./hooks/useNavigation";
import { useOAuth } from "./hooks/useOAuth";
import { usePublish } from "./hooks/usePublish";
import { useRequestHistory } from "./hooks/useRequestHistory";
import { useRequestSender } from "./hooks/useRequestSender";
import { useScratchPad } from "./hooks/useScratchPad";
import { useSession } from "./hooks/useSession";
import { useSettings } from "./hooks/useSettings";
import { useShortcuts } from "./hooks/useShortcuts";
import { useTargeting } from "./hooks/useTargeting";
import { useUpdater } from "./hooks/useUpdater";
import { useWorkspace } from "./hooks/useWorkspace";
import { hostOf } from "./lib/connection";
import { interpolate } from "./lib/env";
import { attachApiIds, belongsTo } from "./lib/history";
import * as library from "./lib/library";
import type { LibraryEntry } from "./lib/library";
import type { ApiSection, TopTab } from "./lib/navigation";
import { describeExpiry } from "./lib/oauth";
import { canPublish, whyNotPublishable } from "./lib/publish";
import { toMarkdown } from "./lib/runner";
import { sendTargetFor } from "./lib/shortcuts";
import { SAMPLE_NAME, SAMPLE_SPEC } from "./lib/sample";
import type { ParsedSpec } from "./lib/spec";
import { apiIdFromRef, apiUrl, consumersUrl } from "./lib/spec0";
import { openInBrowser } from "./lib/store";

/**
 * The composition root: wires the hooks in `src/hooks` to the components in
 * `src/components`. State and behaviour live in the hooks; logic that doesn't
 * need React lives in `src/lib`.
 */
export default function App() {
  const [dragging, setDragging] = useState(false);

  const [hookDismissed, setHookDismissed] = useState(false);

  const { settings, setSettings, patchSettings } = useSettings();
  const { envFile, setEnvFile, saveEnvFile, activeEnv, vars, saveTarget } = useEnvironments();
  const {
    route,
    setRoute,
    current,
    setCurrent,
    spec,
    tab,
    setTab,
    query,
    setQuery,
    view,
    setView,
    operation,
    setOperation,
    schemaName,
    setSchemaName,
    graphFocus,
    setGraphFocus,
    docText,
    docTab,
    setDocTab,
    prefill,
    setPrefill,
    record,
    setRecord,
    copiedFrom,
    setCopiedFrom,
    specFingerprint,
    server,
    setServer,
    auth,
    setAuth,
    showSpec,
    closeApi,
  } = useWorkspace(envFile.activeId, setEnvFile);
  const { requests, setRequests, clearHistory, scratchHistory } = useRequestHistory();
  const { session, setSession, updateSession } = useSession();

  const {
    showOpen,
    setShowOpen,
    openTab,
    showEnvs,
    setShowEnvs,
    showRun,
    setShowRun,
    showOAuth,
    setShowOAuth,
    showSwitcher,
    setShowSwitcher,
    openSignIn,
    closeOpen,
    closeOnEscape,
  } = useDialogs();
  const { connection, setConnection, saveConnectionSettings } = useConnectionSettings();
  const { pad, setPad, updatePad } = useScratchPad();

  const { oauthToken, oauthBusy, oauthError, setOauthError, acquireToken, usableToken, clearToken } =
    useOAuth(current, envFile.activeId, vars, connection);

  const { mockUrl, mock, mockBehind, unverifiedTarget, targetingMock, targets, envVersionSkew } =
    useTargeting({ session, current, spec, server, vars, connection });

  const { runResults, runningOp, runScope, runOperations, cancelRun } = useBulkRun({
    spec,
    server,
    auth,
    vars,
    mock,
    mockUrl,
    connection,
    currentId: current?.id,
    environmentName: activeEnv?.name,
    specFingerprint,
    setRequests,
  });

  const {
    sending,
    result,
    validation,
    requestError,
    curl,
    onValuesChange,
    clearResponse,
    doSend,
    saveResponseBody,
    doScratchSend,
  } = useRequestSender({
    spec,
    operation,
    server,
    auth,
    vars,
    mock,
    mockUrl,
    connection,
    currentId: current?.id,
    environmentName: activeEnv?.name,
    specFingerprint,
    usableToken,
    pad,
    patchSettings,
    setRequests,
    setCopiedFrom,
  });

  const { git, consumers, resetDocumentFacts } = useDocumentFacts(route, current, session);

  /** Show a parsed spec, with a clean response pane and no facts from the last document. */
  const applySpec = useCallback(
    (parsed: ParsedSpec, entry: LibraryEntry, text: string) => {
      showSpec(parsed, entry, text);
      resetDocumentFacts();
      clearResponse();
    },
    [showSpec, resetDocumentFacts, clearResponse],
  );

  const {
    entries,
    setEntries,
    loading,
    loadError,
    checking,
    syncReport,
    setSyncReport,
    fileInput,
    ingest,
    openEntry,
    openFile,
    addFromUrl,
    refreshEntry,
    removeEntry,
    checkForUpdates,
    applyUpdate,
    doRefreshMock,
    saveMockKey,
  } = useLibrary({ session, requests, current, setCurrent, applySpec, closeApi });

  const {
    showPublish,
    setShowPublish,
    teams,
    teamsError,
    publishing,
    publishResult,
    publishError,
    startPublish,
    doPublish,
  } = usePublish(session, current, setEntries);

  useBoot({
    settings: setSettings,
    envFile: setEnvFile,
    requests: setRequests,
    session: setSession,
    entries: setEntries,
    pad: setPad,
    connection: setConnection,
  });

  const nav = useNavigation({ route, setRoute, hasOpenApi: Boolean(spec) });
  const updater = useUpdater();
  const mocks = useMocks(session, route === "mocks");

  const goLibrary = useCallback(() => {
    setRoute("library");
    setRecord(null);
    setShowSwitcher(false);
  }, [setRoute, setRecord, setShowSwitcher]);

  /**
   * History with older entries matched to their API by title where that's
   * unambiguous, so one API never appears twice in the log.
   */
  const log = useMemo(() => attachApiIds(requests, entries), [requests, entries]);
  const apiLog = useMemo(
    () => (current ? log.filter((entry) => belongsTo(entry, current)) : []),
    [log, current],
  );

  const { specFor, copyRecord } = useHistoryRecords({
    entries,
    current,
    spec,
    openEntry,
    setRoute,
    setOperation,
    setPrefill,
    setServer,
    setTab,
    setView,
    setRecord,
    setCopiedFrom,
    updatePad,
    clearResponse,
  });

  const openHistory = useCallback(() => {
    setRecord(null);
    setRoute("history");
  }, [setRecord, setRoute]);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      setDragging(false);
      const file = event.dataTransfer.files?.[0];
      if (file) void file.text().then((text) => ingest(text, file.name, { kind: "file", ref: file.name }));
    },
    [ingest],
  );

  const openScratch = useCallback(() => {
    setRoute("scratch");
    setRecord(null);
    setCopiedFrom(null);
    clearResponse({ curl: true });
  }, [setRoute, setRecord, setCopiedFrom, clearResponse]);

  /** The open API's four views, as the tabs under the top bar show them. */
  const section: ApiSection =
    view === "schema" ? "schemas" : view === "graph" ? "graph" : view === "document" ? "document" : "operations";

  /** Switching what the work area shows closes a recorded request that was open in it. */
  const showView = (next: typeof view) => {
    setRecord(null);
    setView(next);
  };

  const showSection = (next: ApiSection) => {
    if (route !== "api" || !spec) return;
    if (next === "operations") {
      if (tab === "schemas") {
        setTab("operations");
        setQuery("");
      }
      showView("operation");
    } else if (next === "schemas") {
      if (tab !== "schemas") setQuery("");
      setTab("schemas");
      showView("schema");
    } else {
      showView(next);
    }
  };

  const onTopTab = (next: TopTab) => {
    setShowSwitcher(false);
    if (next === "history") setRecord(null);
    nav.goTop(next);
  };

  useShortcuts({
    send: () => {
      // A recorded request has no Send; the shortcut mustn't reach the editor hidden behind it.
      if (record) return;
      const target = sendTargetFor(route);
      if (target === "scratch") void doScratchSend();
      else if (target === "operation") void doSend();
    },
    openAdd: () => setShowOpen(true),
    openSwitcher: () => {
      if (entries.length) setShowSwitcher(true);
    },
    openEnvironments: () => setShowEnvs(true),
    goLibrary,
    toggleInspector: () => patchSettings({ inspectorOpen: !settings.inspectorOpen }),
    showSection,
    openSettings: () => nav.openSettings(),
    toggleTheme: () => patchSettings({ dark: !settings.dark }),
    closeDialogs: closeOnEscape,
  });

  /** Jump to an operation by id from a schema view. */
  const showOperation = (id: string) => {
    const found = spec?.operations.find((op) => op.id === id);
    if (found) {
      setOperation(found);
      setPrefill(null);
      setCopiedFrom(null);
      setRecord(null);
      setTab("operations");
      setView("operation");
    }
  };

  const showGraph = view === "graph";
  const showDocument = view === "document";
  const inspectorVisible = settings.inspectorOpen && !showGraph && !showDocument;
  const onApi = route === "api" && Boolean(spec);
  const onScratch = route === "scratch";
  const onHistory = route === "history";
  const showSidebar = view === "operation" || view === "schema";
  const openNetworkFor = () => nav.openSettings("network", { host: hostOf(interpolate(server, vars)) });

  return (
    <div
      className="app"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <input
        ref={fileInput}
        type="file"
        accept=".yaml,.yml,.json"
        style={{ display: "none" }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void file.text().then((text) => ingest(text, file.name, { kind: "file", ref: file.name }));
        }}
      />

      <TitleBar
        topTab={nav.topTab}
        onTopTab={onTopTab}
        session={session}
        insecureHosts={connection.trusted.some((t) => t.insecure)}
        envFile={envFile}
        onSelectEnvironment={(activeId) => saveEnvFile({ ...envFile, activeId })}
        onEditEnvironments={() => setShowEnvs(true)}
        onOpenAccount={() => nav.openSettings("account")}
        settingsOpen={route === "settings"}
        onOpenSettings={() => nav.openSettings()}
      />

      {onApi && (
        <ApiBar
          kind="api"
          title={spec!.title || current?.title || "Untitled API"}
          version={spec!.version}
          fromSpec0={current?.source.kind === "spec0"}
          section={section}
          onSection={showSection}
          onGoLibrary={goLibrary}
          onSwitchApi={() => setShowSwitcher(true)}
          onRun={() => setShowRun(true)}
          onAddApi={() => setShowOpen(true)}
          inspectorOpen={settings.inspectorOpen}
          onToggleInspector={() => patchSettings({ inspectorOpen: !settings.inspectorOpen })}
        />
      )}
      {onScratch && (
        <ApiBar
          kind="scratch"
          onGoLibrary={goLibrary}
          inspectorOpen={settings.inspectorOpen}
          onToggleInspector={() => patchSettings({ inspectorOpen: !settings.inspectorOpen })}
        />
      )}

      {route === "settings" ? (
        <>
          <SettingsView
            section={nav.settingsSection}
            onSection={nav.setSettingsSection}
            content={{
              account: (
                <AccountSettings
                  session={session}
                  onSignIn={openSignIn}
                  onBrowseCatalog={openSignIn}
                  onSignOut={() => updateSession(null)}
                  onOpenSpec0={() => void openInBrowser(session?.appUrl ?? "")}
                />
              ),
              network: (
                <NetworkSettings
                  settings={connection}
                  onSave={saveConnectionSettings}
                  jar={
                    nav.lastApisRoute === "scratch"
                      ? { id: "__scratch__", title: "Scratch" }
                      : current
                        ? { id: current.id, title: current.title }
                        : null
                  }
                  suggestHost={nav.suggestHost}
                />
              ),
              updates: <UpdateSettings updater={updater} />,
              appearance: (
                <AppearanceSettings
                  dark={settings.dark}
                  onDark={(dark) => patchSettings({ dark })}
                  inspectorOpen={settings.inspectorOpen}
                  onInspectorOpen={(inspectorOpen) => patchSettings({ inspectorOpen })}
                />
              ),
              mcp: <McpSettings />,
              data: <DataSettings historyCount={requests.length} onClearHistory={clearHistory} />,
            }}
          />
          <StatusBar summary="Settings · saved as you change them" envName={activeEnv?.name} result={null} />
        </>
      ) : route === "mocks" ? (
        <>
          <MocksView
            signedIn={Boolean(session)}
            orgName={session?.orgName}
            mocks={mocks.mocks}
            loading={mocks.loading}
            error={mocks.error}
            onRefresh={() => void mocks.refresh()}
            onSignIn={openSignIn}
          />
          <StatusBar
            summary={session ? `Mocks · ${session.orgName}` : "Mocks · sign in to see hosted mocks"}
            envName={activeEnv?.name}
            result={null}
          />
        </>
      ) : route === "mcp" ? (
        <>
          <McpView onOpenSettings={() => nav.openSettings("mcp")} />
          <StatusBar summary="MCP" envName={activeEnv?.name} result={null} />
        </>
      ) : onHistory ? (
        <>
          <HistoryView
            entries={log}
            specFor={specFor}
            onCopy={copyRecord}
            onClear={clearHistory}
          />
          <StatusBar
            summary="History · kept 30 days, only on this machine"
            envName={activeEnv?.name}
            result={null}
          />
        </>
      ) : onScratch ? (
        <>
          <ScratchView
            pad={pad}
            onChange={updatePad}
            vars={vars}
            sending={sending}
            onSend={() => void doScratchSend()}
            history={scratchHistory}
            onOpenRecord={setRecord}
            record={
              record
                ? {
                    id: record.id,
                    view: (
                      <HistoryDetail
                        key={record.id}
                        entry={record}
                        spec={null}
                        onCopy={copyRecord}
                        onClose={() => setRecord(null)}
                      />
                    ),
                  }
                : null
            }
            notice={
              copiedFrom && <CopiedNote at={copiedFrom} onDismiss={() => setCopiedFrom(null)} />
            }
            inspector={
              settings.inspectorOpen && (
                <section className="pane response">
                  <Inspector
                    result={result}
                    validation={null}
                    error={requestError}
                    curl={curl}
                    noSchema
                    showHook={false}
                    onDismissHook={() => {}}
                  />
                </section>
              )
            }
          />
          <StatusBar
            summary="Scratch · one ad-hoc request, not saved"
            envName={activeEnv?.name}
            result={result}
          />
        </>
      ) : !onApi ? (
        <Library
          entries={entries}
          onOpen={(entry) => void openEntry(entry)}
          onRemove={(entry) => void removeEntry(entry)}
          onRename={(entry, title) => void library.renameEntry(entry.id, title).then(setEntries)}
          onRefresh={(entry) => void refreshEntry(entry)}
          onAdd={() => setShowOpen(true)}
          connected={Boolean(session)}
          onCheckUpdates={() => void checkForUpdates()}
          onApplyUpdate={(entry) => void applyUpdate(entry)}
          onRefreshMock={session ? (entry) => void doRefreshMock(entry) : undefined}
          checking={checking}
          syncReport={syncReport}
          onDismissReport={() => setSyncReport(null)}
          onTrySample={() => void ingest(SAMPLE_SPEC, SAMPLE_NAME, { kind: "sample", ref: "sample" })}
          onOpenScratch={openScratch}
          dragging={dragging}
          busy={loading}
          error={loadError}
        />
      ) : (
        <>
          <div className="panes" id={API_PANEL_ID} role="tabpanel" aria-labelledby={`api-tab-${section}`}>
            {showSidebar && (
            <Sidebar
              spec={spec!}
              tab={view === "schema" ? "schemas" : tab === "history" ? "history" : "operations"}
              onTabChange={(next) => {
                setTab(next);
                setQuery("");
              }}
              query={query}
              onQueryChange={setQuery}
              selectedOperation={operation?.id ?? null}
              onSelectOperation={(op) => {
                setOperation(op);
                setPrefill(null);
                setCopiedFrom(null);
                showView("operation");
              }}
              selectedSchema={schemaName}
              onSelectSchema={(name) => {
                setSchemaName(name);
                showView("schema");
              }}
              history={apiLog}
              selectedRecord={record?.id ?? null}
              onOpenRecord={setRecord}
              onOpenAllHistory={openHistory}
            />
            )}

            <div className="workarea">
              {record && (
                <HistoryDetail
                  key={record.id}
                  entry={record}
                  spec={spec}
                  onCopy={copyRecord}
                  onClose={() => setRecord(null)}
                />
              )}
              {!record && (
              <>
              {showDocument && (
                <DocumentView
                  title={spec!.title || current?.title || "Document"}
                  version={spec!.version}
                  text={docText}
                  dark={settings.dark}
                  tab={docTab}
                  onTabChange={setDocTab}
                  git={git}
                  consumers={consumers}
                  onOpenConsumers={() => {
                    const apiId = current ? apiIdFromRef(current.source.ref) : null;
                    if (apiId) void openInBrowser(consumersUrl(session?.appUrl ?? "", apiId));
                  }}
                  publishBlockedReason={
                    canPublish(current?.source) ? null : whyNotPublishable(current?.source)
                  }
                  onPublish={startPublish}
                />
              )}

              {showGraph && (
                <GraphView
                  spec={spec!}
                  focus={graphFocus}
                  onFocus={setGraphFocus}
                  panelWidth={settings.graphPanel}
                  onPanelWidth={(graphPanel) => patchSettings({ graphPanel })}
                  onSelectOperation={showOperation}
                />
              )}

              {view === "operation" &&
                (operation ? (
                  <>
                    <UrlBar
                      op={operation}
                      targets={targets}
                      specServers={spec!.servers}
                      mockUrl={mockUrl}
                      value={server}
                      onChange={setServer}
                      vars={vars}
                      sending={sending}
                      onSend={() => void doSend()}
                      onSaveTarget={saveTarget}
                      unverified={unverifiedTarget}
                      onOpenConnection={openNetworkFor}
                      envSkew={envVersionSkew}
                    />
                    {targetingMock && !current?.mockApiKey && (
                      <MockKeyBar
                        apiName={current?.title ?? "this API"}
                        onSave={(key) => void saveMockKey(key)}
                      />
                    )}
                    {copiedFrom && (
                      <CopiedNote at={copiedFrom} onDismiss={() => setCopiedFrom(null)} />
                    )}
                    <div className="split">
                      <section className="pane request">
                        <OperationView
                          spec={spec!}
                          op={operation}
                          auth={auth}
                          onAuthChange={setAuth}
                          onValuesChange={onValuesChange}
                          prefill={prefill}
                          onConfigureOAuth={(schemeName) => setShowOAuth({ prefill: schemeName })}
                          oauthStatus={
                            current?.oauth
                              ? { ok: Boolean(oauthToken?.accessToken), label: describeExpiry(oauthToken) }
                              : null
                          }
                        />
                      </section>
                      {inspectorVisible && (
                        <section className="pane response">
                          <Inspector
                            result={result}
                            validation={validation}
                            error={requestError}
                            curl={curl}
                            onSaveBody={(type) => void saveResponseBody(type)}
                            mockStale={mockBehind && targetingMock}
                            onRefreshMock={
                              session && current?.mockServerId
                                ? () => void doRefreshMock()
                                : undefined
                            }
                            showHook={!hookDismissed && !session}
                            onDismissHook={() => setHookDismissed(true)}
                          />
                        </section>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="empty">
                    <p>This spec declares no operations.</p>
                  </div>
                ))}

              {view === "schema" &&
                (schemaName ? (
                  <SchemaView
                    spec={spec!}
                    name={schemaName}
                    onSelectSchema={(name) => {
                      setSchemaName(name);
                      setTab("schemas");
                      setView("schema");
                    }}
                    onSelectOperation={showOperation}
                  />
                ) : (
                  <div className="empty">
                    <p>This spec declares no component schemas.</p>
                  </div>
                ))}
              </>
              )}
            </div>
          </div>

          <StatusBar
            summary={
              <>
                {spec!.operations.length} operations · {spec!.schemas.length} schemas · {spec!.tags.length} tags
              </>
            }
            envName={activeEnv?.name}
            orgName={session?.orgName}
            result={result}
          />
        </>
      )}

      {showSwitcher && (
        <ApiSwitcher
          entries={entries}
          currentId={current?.id ?? null}
          onPick={(entry) => {
            setShowSwitcher(false);
            void openEntry(entry);
          }}
          onGoLibrary={goLibrary}
          onClose={() => setShowSwitcher(false)}
        />
      )}

      {showOAuth && current && spec && (
        <OAuthDialog
          config={current.oauth ?? null}
          token={oauthToken}
          schemes={spec.securitySchemes}
          prefillFrom={showOAuth.prefill}
          varNames={Object.keys(vars)}
          activeEnvName={activeEnv?.name ?? null}
          busy={oauthBusy}
          error={oauthError}
          onSave={(config) => {
            void library.setOAuth(current.id, config).then((next) => {
              setEntries(next);
              setCurrent(next.find((entry) => entry.id === current.id) ?? current);
            });
          }}
          onAcquire={(config) => void acquireToken(config)}
          onClear={clearToken}
          onClose={() => {
            setShowOAuth(null);
            setOauthError(null);
          }}
        />
      )}

      {showRun && spec && (
        <RunDialog
          tags={spec.tags}
          operations={spec.operations}
          vars={vars}
          target={interpolate(server, vars)}
          running={runningOp !== null}
          results={runResults}
          current={runningOp}
          onRun={(operations, options, scope) => void runOperations(operations, options, scope)}
          onCancel={cancelRun}
          onCopyReport={() =>
            void navigator.clipboard.writeText(
              toMarkdown(runResults, {
                title: spec.title,
                target: interpolate(server, vars),
                scope: runScope,
              }),
            )
          }
          onClose={() => setShowRun(false)}
        />
      )}

      {showPublish && current && spec && (
        <PublishDialog
          signedIn={Boolean(session)}
          onSignIn={() => {
            setShowPublish(false);
            openSignIn();
          }}
          title={spec.title || current.title}
          version={spec.version}
          text={docText}
          git={git}
          teams={teams}
          teamsError={teamsError}
          busy={publishing}
          result={publishResult}
          error={publishError}
          onPublish={(body) => void doPublish(body)}
          onOpenPublished={(id) => void openInBrowser(apiUrl(session?.appUrl ?? "", id))}
          onClose={() => setShowPublish(false)}
        />
      )}

      {showEnvs && (
        <EnvironmentsDialog
          file={envFile}
          onSave={saveEnvFile}
          onClose={() => setShowEnvs(false)}
        />
      )}

      {showOpen && (
        <OpenDialog
          initialSource={openTab}
          session={session}
          onSession={updateSession}
          onOpenFile={() => void openFile()}
          onOpenUrl={(url) => void addFromUrl(url)}
          onOpenSpec0={(text, name, source, mock) => {
            void ingest(text, name, { kind: "spec0", ref: source }, mock);
          }}
          onTrySample={() => void ingest(SAMPLE_SPEC, SAMPLE_NAME, { kind: "sample", ref: "sample" })}
          onClose={closeOpen}
        />
      )}

      <UpdateDialog updater={updater} />
    </div>
  );
}
