import { useCallback, useState } from "react";
import { ApiSwitcher } from "./components/ApiSwitcher";
import { ConnectionDialog } from "./components/ConnectionDialog";
import { DocumentView } from "./components/DocumentView";
import { EnvironmentsDialog } from "./components/EnvironmentsDialog";
import { GraphView } from "./components/GraphView";
import { Inspector } from "./components/Inspector";
import { Library } from "./components/Library";
import { MockKeyBar } from "./components/MockKeyBar";
import { OAuthDialog } from "./components/OAuthDialog";
import { OpenDialog } from "./components/OpenDialog";
import { OperationView } from "./components/OperationView";
import { PublishDialog } from "./components/PublishDialog";
import { RecordBar } from "./components/RecordBar";
import { RunDialog } from "./components/RunDialog";
import { SchemaView } from "./components/SchemaView";
import { ScratchView } from "./components/ScratchView";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { TitleBar } from "./components/TitleBar";
import { Updater } from "./components/UpdateDialog";
import { UrlBar } from "./components/UrlBar";
import { useBoot } from "./hooks/useBoot";
import { useBulkRun } from "./hooks/useBulkRun";
import { useConnectionSettings } from "./hooks/useConnectionSettings";
import { useDialogs } from "./hooks/useDialogs";
import { useDocumentFacts } from "./hooks/useDocumentFacts";
import { useEnvironments } from "./hooks/useEnvironments";
import { useLibrary } from "./hooks/useLibrary";
import { useOAuth } from "./hooks/useOAuth";
import { usePublish } from "./hooks/usePublish";
import { useRequestHistory } from "./hooks/useRequestHistory";
import { useRequestSender } from "./hooks/useRequestSender";
import { useScratchPad } from "./hooks/useScratchPad";
import { useSession } from "./hooks/useSession";
import { useSettings } from "./hooks/useSettings";
import { useShortcuts } from "./hooks/useShortcuts";
import { useTargeting } from "./hooks/useTargeting";
import { useWorkspace } from "./hooks/useWorkspace";
import { hostOf } from "./lib/connection";
import { interpolate } from "./lib/env";
import * as library from "./lib/library";
import type { LibraryEntry } from "./lib/library";
import { describeExpiry } from "./lib/oauth";
import { canPublish, whyNotPublishable } from "./lib/publish";
import { toMarkdown } from "./lib/runner";
import { SAMPLE_NAME, SAMPLE_SPEC } from "./lib/sample";
import type { ParsedSpec } from "./lib/spec";
import { apiIdFromRef, apiUrl, consumersUrl } from "./lib/spec0";

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
    replay,
    setReplay,
    viewingRecord,
    setViewingRecord,
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
    showConnection,
    setShowConnection,
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
    replayScratch,
    doReplay,
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
    usableToken,
    pad,
    updatePad,
    patchSettings,
    setRequests,
    setOperation,
    setReplay,
    setViewingRecord,
    setTab,
    setView,
    setServer,
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
    openUrl,
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

  const goLibrary = useCallback(() => {
    setRoute("library");
    setShowSwitcher(false);
  }, [setRoute, setShowSwitcher]);

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
    clearResponse({ curl: true });
  }, [setRoute, clearResponse]);

  useShortcuts({
    send: () => void doSend(),
    openAdd: () => setShowOpen(true),
    openSwitcher: () => {
      if (entries.length) setShowSwitcher(true);
    },
    openEnvironments: () => setShowEnvs(true),
    goLibrary,
    toggleInspector: () => patchSettings({ inspectorOpen: !settings.inspectorOpen }),
    showTab: setTab,
    toggleTheme: () => patchSettings({ dark: !settings.dark }),
    closeDialogs: closeOnEscape,
  });

  /** Jump to an operation by id from a schema view. */
  const showOperation = (id: string) => {
    const found = spec?.operations.find((op) => op.id === id);
    if (found) {
      setOperation(found);
      setTab("operations");
      setView("operation");
    }
  };

  const showGraph = view === "graph";
  const showDocument = view === "document";
  const inspectorVisible = settings.inspectorOpen && !showGraph && !showDocument;
  const onApi = route === "api" && Boolean(spec);
  const onScratch = route === "scratch";

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
        onScratch={onScratch}
        onApi={onApi}
        specTitle={spec?.title}
        specVersion={spec?.version}
        fromSpec0={current?.source.kind === "spec0"}
        session={session}
        insecureHosts={connection.trusted.some((t) => t.insecure)}
        envFile={envFile}
        onSelectEnvironment={(activeId) => saveEnvFile({ ...envFile, activeId })}
        onEditEnvironments={() => setShowEnvs(true)}
        inspectorOpen={settings.inspectorOpen}
        onToggleInspector={() => patchSettings({ inspectorOpen: !settings.inspectorOpen })}
        showDocument={showDocument}
        onToggleDocument={() => setView(showDocument ? "operation" : "document")}
        showGraph={showGraph}
        onToggleGraph={() => setView(showGraph ? "operation" : "graph")}
        dark={settings.dark}
        onToggleTheme={() => patchSettings({ dark: !settings.dark })}
        onGoLibrary={goLibrary}
        onSwitchApi={() => setShowSwitcher(true)}
        onSignIn={openSignIn}
        onOpenConnection={() => setShowConnection(true)}
        onRun={() => setShowRun(true)}
        onAddApi={() => setShowOpen(true)}
      />

      {onScratch ? (
        <>
          <ScratchView
            pad={pad}
            onChange={updatePad}
            vars={vars}
            sending={sending}
            onSend={() => void doScratchSend()}
            history={scratchHistory}
            onReplay={replayScratch}
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
          <div className="panes">
            <Sidebar
              spec={spec!}
              tab={tab}
              onTabChange={(next) => {
                setTab(next);
                setQuery("");
                if (next === "operations") setView("operation");
                if (next === "schemas") setView("schema");
              }}
              query={query}
              onQueryChange={setQuery}
              selectedOperation={operation?.id ?? null}
              onSelectOperation={(op) => {
                setOperation(op);
                setReplay(null);
                setViewingRecord(null);
                setView("operation");
              }}
              selectedSchema={schemaName}
              onSelectSchema={(name) => {
                setSchemaName(name);
                setView("schema");
              }}
              history={requests}
              onReplay={doReplay}
              onClearHistory={clearHistory}
            />

            <div className="workarea">
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
                    if (apiId) void openUrl(consumersUrl(session?.appUrl ?? "", apiId));
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
                      onOpenConnection={() => setShowConnection(true)}
                      envSkew={envVersionSkew}
                    />
                    {targetingMock && !current?.mockApiKey && (
                      <MockKeyBar
                        apiName={current?.title ?? "this API"}
                        onSave={(key) => void saveMockKey(key)}
                      />
                    )}
                    {viewingRecord && (
                      <RecordBar entry={viewingRecord} onDismiss={() => setViewingRecord(null)} />
                    )}
                    <div className="split">
                      <section className="pane request">
                        <OperationView
                          spec={spec!}
                          op={operation}
                          auth={auth}
                          onAuthChange={setAuth}
                          onValuesChange={onValuesChange}
                          replay={replay}
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

      {showConnection && (
        <ConnectionDialog
          settings={connection}
          onSave={saveConnectionSettings}
          jar={onScratch ? { id: "__scratch__", title: "Scratch" } : current ? { id: current.id, title: current.title } : null}
          suggestHost={hostOf(interpolate(server, vars))}
          onClose={() => setShowConnection(false)}
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
          onOpenPublished={(id) => void openUrl(apiUrl(session?.appUrl ?? "", id))}
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
          onOpenUrl={(url) => void openUrl(url)}
          onOpenSpec0={(text, name, source, mock) => {
            void ingest(text, name, { kind: "spec0", ref: source }, mock);
          }}
          onTrySample={() => void ingest(SAMPLE_SPEC, SAMPLE_NAME, { kind: "sample", ref: "sample" })}
          onClose={closeOpen}
        />
      )}

      <Updater />
    </div>
  );
}
