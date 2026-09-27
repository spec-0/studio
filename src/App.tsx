import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Sidebar, type SidebarTab } from "./components/Sidebar";
import { DocumentView, type DocumentTab } from "./components/DocumentView";
import { readGitInfo, type GitInfo } from "./lib/git";
import { PublishDialog } from "./components/PublishDialog";
import { canPublish, whyNotPublishable } from "./lib/publish";
import { OperationView, type RequestValues } from "./components/OperationView";
import { Inspector } from "./components/Inspector";
import { SchemaView } from "./components/SchemaView";
import { UrlBar } from "./components/UrlBar";
import { MockKeyBar } from "./components/MockKeyBar";
import { EnvironmentsDialog } from "./components/EnvironmentsDialog";
import { ConnectionDialog } from "./components/ConnectionDialog";
import { OAuthDialog } from "./components/OAuthDialog";
import { RunDialog } from "./components/RunDialog";
import { OpenDialog } from "./components/OpenDialog";
import { Library } from "./components/Library";
import { ScratchView } from "./components/ScratchView";
import { ApiSwitcher } from "./components/ApiSwitcher";
import { Updater } from "./components/UpdateDialog";
import { TitleBar } from "./components/TitleBar";
import { StatusBar } from "./components/StatusBar";
import { GraphView } from "./components/GraphView";
import { fileName } from "./lib/platform";
import { parseSpec, type OperationSpec, type ParsedSpec } from "./lib/spec";
import {
  appFetch,
  buildPlan,
  inTauri,
  send,
  describeBody,
  initialAuth,
  toCurl,
  type AuthState,
  type ResponseResult,
} from "./lib/request";
import { validateResponse, type ValidationResult } from "./lib/validate";
import { interpolate, loadEnvironments } from "./lib/env";
import * as history from "./lib/history";
import type { HistoryEntry } from "./lib/history";
import * as library from "./lib/library";
import type { ApiSource, LibraryEntry } from "./lib/library";
import {
  pickSaveTarget,
  pickSpecFile,
  readStore,
  saveResponseTo,
  STORE,
} from "./lib/store";
import {
  DEFAULT_CONNECTION,
  hostOf,
  loadConnection,
  saveConnection,
  transportFor,
  type ConnectionSettings,
} from "./lib/connection";
import {
  apiIdFromRef,
  getApiConsumers,
  consumersUrl,
  apiUrl,
  type ApiConsumers,
  fetchTeamApiSpec,
  listApiEnvironments,
  loadSession,
  refreshMock,
  saveSession,
  upstreamVersions,
  type Session,
} from "./lib/spec0";
import {
  EMPTY_PAD,
  SCRATCH_OPERATION_ID,
  SCRATCH_TITLE,
  buildScratchPlan,
  loadScratch,
  padFromHistory,
  saveScratch,
  scratchPath,
  type ScratchPad,
} from "./lib/scratch";
import { describeExpiry } from "./lib/oauth";
import {
  toMarkdown,
} from "./lib/runner";
import {
  sentToMock,
} from "./lib/targets";
import {
  declaredResponse,
  describeSendError,
  responseFromHistory,
  storedResponseBody,
  suggestedFileName,
} from "./lib/response";
import { DEFAULT_SETTINGS, useSettings, type Settings } from "./hooks/useSettings";
import { useTargeting } from "./hooks/useTargeting";
import { useBulkRun } from "./hooks/useBulkRun";
import { usePublish } from "./hooks/usePublish";
import { useShortcuts } from "./hooks/useShortcuts";
import { useOAuth } from "./hooks/useOAuth";
import { useEnvironments } from "./hooks/useEnvironments";
import { SAMPLE_NAME, SAMPLE_SPEC } from "./lib/sample";
import {
  describeImpact,
  describeMockRefresh,
  diffSpecs,
  isNoteworthy,
  updateMarks,
} from "./lib/sync";

type MainView = "operation" | "schema" | "graph" | "document";
type Route = "library" | "api" | "scratch";

export default function App() {
  const [route, setRoute] = useState<Route>("library");
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [current, setCurrent] = useState<LibraryEntry | null>(null);

  const [spec, setSpec] = useState<ParsedSpec | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const [tab, setTab] = useState<SidebarTab>("operations");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<MainView>("operation");
  const [operation, setOperation] = useState<OperationSpec | null>(null);
  const [schemaName, setSchemaName] = useState<string | null>(null);
  const [graphFocus, setGraphFocus] = useState<string | null>(null);

  // The document itself: the text as imported, plus the two facts about
  // it that Studio can't read out of the spec — where the file came from, and
  // who depends on the API. Both are optional and neither gates the view.
  const [docText, setDocText] = useState("");
  const [docTab, setDocTab] = useState<DocumentTab>("reference");
  const [git, setGit] = useState<GitInfo | null>(null);
  const [consumers, setConsumers] = useState<ApiConsumers | null>(null);

  const [replay, setReplay] = useState<{
    headers: Record<string, string>;
    body?: string;
    pathParams?: Record<string, string>;
    queryParams?: Record<string, string>;
  } | null>(null);
  /**
   * The history entry currently on screen, if the panes are showing a record
   * rather than something just sent.
   *
   * Without this the two are indistinguishable: replayed values are merged into
   * the live editors and the recorded response fills the inspector, so a result
   * from three weeks ago looks exactly like one from three seconds ago. The
   * banner is the only thing that says which you are reading.
   */
  const [viewingRecord, setViewingRecord] = useState<HistoryEntry | null>(null);

  const [server, setServer] = useState("");
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<ResponseResult | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [curl, setCurl] = useState<string | null>(null);
  const [hookDismissed, setHookDismissed] = useState(false);

  const { settings, setSettings, patchSettings } = useSettings();
  const { envFile, setEnvFile, saveEnvFile, activeEnv, vars, saveTarget } = useEnvironments();
  const [requests, setRequests] = useState<HistoryEntry[]>([]);
  const [session, setSession] = useState<Session | null>(null);

  const [showOpen, setShowOpen] = useState(false);
  const [openTab, setOpenTab] = useState<"file" | "url" | "spec0">("file");
  const [showEnvs, setShowEnvs] = useState(false);
  const [showConnection, setShowConnection] = useState(false);
  const [showRun, setShowRun] = useState(false);
  const [showOAuth, setShowOAuth] = useState<{ prefill?: string } | null>(null);
  const [connection, setConnection] = useState<ConnectionSettings>(DEFAULT_CONNECTION);
  const [showSwitcher, setShowSwitcher] = useState(false);
  const [checking, setChecking] = useState(false);
  const [pad, setPad] = useState<ScratchPad>(EMPTY_PAD);
  const [syncReport, setSyncReport] = useState<{ title: string; lines: string[] } | null>(null);

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

  const values = useRef<RequestValues>({ pathParams: {}, queryParams: {}, headerParams: {}, body: "" });
  const onValuesChange = useCallback((next: RequestValues) => {
    values.current = next;
  }, []);
  const fileInput = useRef<HTMLInputElement>(null);

  // ── boot ─────────────────────────────────────────────────────────────────────

  useEffect(() => {
    void (async () => {
      setSettings(await readStore<Settings>(STORE.settings, DEFAULT_SETTINGS));
      setEnvFile(await loadEnvironments());
      // Secrets are known now; strip any that older versions wrote into history.
      await history.scrubHistory();
      setRequests(await history.loadHistory());
      setSession(await loadSession());
      setEntries(await library.loadLibrary());
      setPad(await loadScratch());
      setConnection(await loadConnection());
    })();
  }, []);

  const saveConnectionSettings = useCallback((next: ConnectionSettings) => {
    setConnection(next);
    void saveConnection(next);
  }, []);

  /**
   * Rebuild the mock against the spec we now hold.
   *
   * The platform keeps the mock's id, URL and API key, so nothing stored here has
   * to change — only the version it serves, which is what clears the skew warning.
   */
  const doRefreshMock = useCallback(async (target?: LibraryEntry) => {
    const entry = target ?? current;
    if (!session || !entry?.mockServerId) return;
    setLoading(`Rebuilding the mock for ${entry.title}…`);
    setLoadError(null);
    try {
      const result = await refreshMock(session, entry.mockServerId);
      const next = await library.setMock(entry.id, {
        mockSpecVersion: result.specVersion ?? entry.version,
        clearStale: true,
      });
      setEntries(next);
      setCurrent((open) => (open?.id === entry.id ? next.find((e) => e.id === entry.id) ?? open : open));

      setSyncReport({ title: `${entry.title} mock`, lines: describeMockRefresh(result) });
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(null);
    }
  }, [session, current]);

  const saveMockKey = useCallback(
    async (key: string) => {
      if (!current) return;
      const next = await library.setMock(current.id, { mockApiKey: key });
      setEntries(next);
      setCurrent(next.find((entry) => entry.id === current.id) ?? current);
    },
    [current],
  );

  // Remember where you were in each API, so coming back doesn't mean re-entering everything.
  useEffect(() => {
    if (route !== "api" || !current) return;
    void library.saveApiState(current.id, {
      server,
      envId: envFile.activeId,
      lastOperationId: operation?.id ?? null,
      tab,
      authScheme: auth?.schemeName ?? null,
      docTab,
    });
  }, [route, current, server, envFile.activeId, operation, tab, auth?.schemeName, docTab]);

  /**
   * Where the open document came from, when it came from a file in a repo.
   *
   * Read live rather than cached on the entry: a branch you switched twenty
   * minutes ago is worse than no branch at all, and the read is local and cheap.
   * A spec from a URL or from spec0 has no repository behind it and reports
   * nothing, which is the ordinary case rather than a failure.
   */
  useEffect(() => {
    if (route !== "api" || !current) return;
    let live = true;
    void readGitInfo(current.source).then((info) => {
      if (live) setGit(info);
    });
    return () => {
      live = false;
    };
  }, [route, current]);

  /**
   * How many consumers the platform knows about.
   *
   * The only part of this view that needs a session. It is additive by
   * construction: no session, no endpoint, or a token that has stopped working
   * all leave the count absent and everything else on screen untouched.
   */
  useEffect(() => {
    if (route !== "api" || !session || current?.source.kind !== "spec0") return;
    const apiId = apiIdFromRef(current.source.ref);
    if (!apiId) return;
    let live = true;
    void getApiConsumers(session, apiId)
      .then((found) => {
        if (live) setConsumers(found);
      })
      .catch(() => {
        if (live) setConsumers(null);
      });
    return () => {
      live = false;
    };
  }, [route, session, current]);

  // ── opening ──────────────────────────────────────────────────────────────────

  const applySpec = useCallback(
    (parsed: ParsedSpec, entry: LibraryEntry, text: string) => {
      const state = entry.state ?? {};
      setSpec(parsed);
      setCurrent(entry);
      setLoadError(null);
      setRoute("api");

      // Keep the bytes, not just the parse — the Raw tab shows the document
      // that was imported, and the Reference tab renders the same string, so
      // the two can never disagree about what the spec says.
      setDocText(text);
      setDocTab(state.docTab ?? "reference");
      setGit(null);
      setConsumers(null);

      const restoredOperation =
        parsed.operations.find((op) => op.id === state.lastOperationId) ?? parsed.operations[0] ?? null;
      setOperation(restoredOperation);
      setSchemaName(parsed.schemas[0]?.name ?? null);
      setTab(state.tab ?? "operations");
      setView(state.tab === "schemas" ? "schema" : "operation");
      setServer(state.server ?? parsed.servers[0] ?? "");
      if (state.envId !== undefined && state.envId !== envFile.activeId) {
        setEnvFile((prev) => ({ ...prev, activeId: state.envId ?? null }));
      }

      setResult(null);
      setValidation(null);
      setRequestError(null);
      setReplay(null);

      setAuth(initialAuth(parsed.securitySchemes, state.authScheme));
    },
    [envFile.activeId],
  );

  /** Parse, add to the library, and open it. Every entry point funnels through here. */
  const ingest = useCallback(
    async (
      text: string,
      name: string,
      source: ApiSource,
      mock?: {
        mockUrl?: string | null;
        mockApiKey?: string | null;
        mockServerId?: string | null;
        mockSpecVersion?: string | null;
      } | null,
    ) => {
      try {
        const parsed = parseSpec(text, name);
        const entry = await library.addToLibrary({
          title: parsed.title || name,
          version: parsed.version,
          source,
          text,
          operations: parsed.operations.length,
          schemas: parsed.schemas.length,
          mockUrl: mock?.mockUrl,
          mockApiKey: mock?.mockApiKey,
          mockServerId: mock?.mockServerId,
          mockSpecVersion: mock?.mockSpecVersion,
        });
        setEntries(await library.loadLibrary());
        applySpec(parsed, entry, text);
      } catch (error) {
        setLoadError(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [applySpec],
  );

  const openEntry = useCallback(
    async (entry: LibraryEntry) => {
      setLoading(`Opening ${entry.title}…`);
      setLoadError(null);
      try {
        const text = await library.readSpecText(entry.id);
        if (!text) {
          setLoadError(`${entry.title}: the stored document is missing. Refresh or re-add it.`);
          return;
        }
        applySpec(parseSpec(text, entry.title), entry, text);
        setEntries(await library.touchOpened(entry.id));
        void syncEnvironments(entry);
      } catch (error) {
        setLoadError(`${entry.title}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setLoading(null);
      }
    },
    [applySpec],
  );

  /**
   * Refresh the cached environment list for a spec0-sourced API.
   *
   * Fire-and-forget on open: the API is already usable without it, so a platform that
   * is slow, unreachable or predates the endpoint must not delay or fail the open. A
   * failure leaves the cached list in place — last known targets beat none.
   *
   * Replaces rather than merges, so an environment retired upstream stops being
   * offered here. That matters more than it sounds: a hostname that was staging last
   * month may belong to something else now.
   */
  const syncEnvironments = useCallback(
    async (entry: LibraryEntry) => {
      if (!session || entry.source.kind !== "spec0") return;
      const apiId = apiIdFromRef(entry.source.ref);
      if (!apiId) return;
      try {
        const rows = await listApiEnvironments(session, apiId);
        const next = await library.setEnvironments(
          entry.id,
          rows.map((row) => ({
            name: row.name,
            url: row.url,
            currentVersion: row.currentVersion ?? null,
          })),
        );
        setEntries(next);
        setCurrent((open) =>
          open?.id === entry.id ? (next.find((e) => e.id === entry.id) ?? open) : open,
        );
      } catch {
        // Deliberately silent: this enriches an API that opened fine. Surfacing an
        // error here would make a working client look broken over a convenience.
      }
    },
    [session],
  );

  // ── updates ──────────────────────────────────────────────────────────────────

  /**
   * Ask the catalog what it holds and mark anything newer than our copy.
   *
   * One `listTeamApis` call covers the whole library — the list already carries
   * `version` and `updatedAt`. Detection is passive: it marks, it never applies.
   * The spec you're testing against must not change under you mid-session.
   */
  const checkForUpdates = useCallback(async () => {
    if (!session) return;
    setChecking(true);
    try {
      const upstream = await upstreamVersions(session);
      const marks = updateMarks(entries, upstream, new Date().toISOString());
      setEntries(await library.setUpdates(marks));
    } catch {
      // A failed check is not worth interrupting anyone for — the badge simply
      // doesn't appear, and Refresh is still there.
    } finally {
      setChecking(false);
    }
  }, [session, entries]);

  /** Pull the newer spec, replace the stored copy, and say what it did locally. */
  const applyUpdate = useCallback(
    async (entry: LibraryEntry) => {
      if (!session || entry.source.kind !== "spec0") return;
      const apiId = apiIdFromRef(entry.source.ref);
      if (!apiId) return;

      setLoading(`Updating ${entry.title}…`);
      setLoadError(null);
      try {
        const text = await fetchTeamApiSpec(session, apiId);
        const after = parseSpec(text, entry.title);

        const previous = await library.readSpecText(entry.id);
        const impact = previous
          ? diffSpecs(parseSpec(previous, entry.title), after, {
              server: entry.state?.server ?? "",
              history: requests,
              specTitle: entry.title,
              hasMock: Boolean(entry.mockUrl),
            })
          : null;

        const next = await library.applyUpdate(entry.id, {
          text,
          title: after.title,
          version: after.version,
          operations: after.operations.length,
          schemas: after.schemas.length,
        });
        setEntries(next);

        // Reflect the new document immediately if this API is the one on screen.
        const updated = next.find((row) => row.id === entry.id);
        if (updated && current?.id === entry.id) applySpec(after, updated, text);

        setSyncReport(
          impact && isNoteworthy(impact)
            ? { title: entry.title, lines: describeImpact(impact) }
            : { title: entry.title, lines: describeImpact(impact ?? ({} as never)) },
        );
      } catch (error) {
        setLoadError(`${entry.title}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setLoading(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, requests, current, applySpec],
  );

  // Check once when a session is available, then only on demand.
  useEffect(() => {
    if (session && entries.length) void checkForUpdates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const openFile = useCallback(async () => {
    if (!inTauri) {
      fileInput.current?.click();
      return;
    }
    const picked = await pickSpecFile();
    if (picked) {
      await ingest(picked.text, fileName(picked.path), {
        kind: "file",
        ref: picked.path,
      });
    }
  }, [ingest]);

  const openUrl = useCallback(
    async (url: string) => {
      setLoading(`Fetching ${url}…`);
      setLoadError(null);
      try {
        const response = await appFetch(url, {
          headers: { Accept: "application/yaml, application/json, */*" },
        });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        await ingest(await response.text(), url.split("/").pop() || url, { kind: "url", ref: url });
      } catch (error) {
        setLoadError(
          `${url}: ${error instanceof Error ? error.message : String(error)}${
            inTauri ? "" : " — in the browser preview this is usually CORS."
          }`,
        );
      } finally {
        setLoading(null);
      }
    },
    [ingest],
  );

  const refreshEntry = useCallback(
    async (entry: LibraryEntry) => {
      setLoading(`Refreshing ${entry.title}…`);
      setLoadError(null);
      try {
        if (entry.source.kind === "url") {
          const response = await appFetch(entry.source.ref);
          if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
          await ingest(await response.text(), entry.title, entry.source);
        } else if (entry.source.kind === "file") {
          const text = await library.rereadFile(entry);
          if (!text) throw new Error("the file is no longer readable at its original path");
          await ingest(text, entry.title, entry.source);
        } else if (entry.source.kind === "spec0") {
          setLoadError("Re-pull this one from the spec0 tab in Open.");
        }
        setEntries(await library.loadLibrary());
      } catch (error) {
        setLoadError(`${entry.title}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setLoading(null);
      }
    },
    [ingest],
  );

  const goLibrary = useCallback(() => {
    setRoute("library");
    setShowSwitcher(false);
  }, []);

  const removeEntry = useCallback(
    async (entry: LibraryEntry) => {
      setEntries(await library.removeEntry(entry.id));
      if (current?.id === entry.id) {
        setCurrent(null);
        setSpec(null);
        setRoute("library");
      }
    },
    [current],
  );

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      setDragging(false);
      const file = event.dataTransfer.files?.[0];
      if (file) void file.text().then((text) => ingest(text, file.name, { kind: "file", ref: file.name }));
    },
    [ingest],
  );

  // ── sending ──────────────────────────────────────────────────────────────────

  const doSend = useCallback(async () => {
    if (!spec || !operation || !server.trim()) return;
    setSending(true);
    setRequestError(null);
    setResult(null);
    setValidation(null);
    // Whatever comes back is live, so the panes are no longer showing a record.
    setViewingRecord(null);
    try {
      const { pathParams, queryParams, headerParams, body } = values.current;
      // An OAuth "value" isn't typed by the user — it's the acquired token,
      // resolved (and renewed if needed) at the moment of sending.
      const effectiveAuth =
        auth?.type === "oauth2" ? { ...auth, value: await usableToken() } : auth;
      const plan = buildPlan(
        operation,
        server,
        pathParams,
        queryParams,
        headerParams,
        effectiveAuth,
        body,
        vars,
        mock,
      );
      setCurl(toCurl(plan));
      const response = await send(plan, {
        ...transportFor(connection, plan.url),
        // Cookies are per-API, keyed by the library entry, so a session picked
        // up here is never offered to a different API's host.
        jar: current?.id,
      });
      setResult(response);

      const declared = declaredResponse(operation.responses, response.status);
      const verdict = validateResponse(spec.doc, declared?.schema, response.json);
      setValidation(verdict);
      patchSettings({ inspectorOpen: true });

      setRequests(
        await history.record({
          method: operation.method,
          path: operation.path,
          url: plan.url,
          status: response.status,
          ms: response.ms,
          bytes: response.bytes,
          specTitle: spec.title,
          operationId: operation.id,
          headers: plan.headers,
          body: describeBody(plan.body),
          bodyKind: plan.body?.kind,
          validation: verdict.status,
          mock: sentToMock(plan.url, mockUrl),
          statusText: response.statusText,
          responseHeaders: response.headers,
          responseBody: storedResponseBody(response),
        }),
      );
    } catch (error) {
      setRequestError(describeSendError(error, inTauri));
    } finally {
      setSending(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, operation, server, auth, vars, mockUrl, mock, connection, current?.id, usableToken]);

  /**
   * Write the held response body wherever the user asks.
   *
   * A copy of the temp file Rust already wrote, not a second request — the bytes
   * were kept precisely so saving them doesn't mean fetching them again.
   */
  const saveResponseBody = useCallback(async (contentType: string) => {
    const path = result?.binary?.path;
    if (!path) return;
    const disposition = result?.headers?.["content-disposition"] ?? "";
    const target = await pickSaveTarget(suggestedFileName(disposition, contentType));
    if (!target) return;
    try {
      await saveResponseTo(path, target);
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : String(error));
    }
  }, [result]);

  const updatePad = useCallback((next: ScratchPad) => {
    setPad(next);
    void saveScratch(next);
  }, []);

  /**
   * Send the scratch request.
   *
   * Deliberately a sibling of `doSend` rather than a branch inside it: there is
   * no operation, no declared response and nothing to validate, so every step
   * that makes `doSend` worth having is absent here. Folding them together would
   * mean threading "…unless there's no spec" through all of it.
   */
  const doScratchSend = useCallback(async () => {
    setSending(true);
    setRequestError(null);
    setResult(null);
    setValidation(null);
    try {
      const plan = buildScratchPlan(pad, vars);
      setCurl(toCurl(plan));
      // The scratch pad gets its own jar: it isn't an API and shouldn't borrow
      // one's session, nor leak a login it performed into a real API's.
      const response = await send(plan, { ...transportFor(connection, plan.url), jar: "__scratch__" });
      setResult(response);
      patchSettings({ inspectorOpen: true });

      setRequests(
        await history.record({
          method: plan.method,
          path: scratchPath(plan.url),
          url: plan.url,
          status: response.status,
          ms: response.ms,
          bytes: response.bytes,
          specTitle: SCRATCH_TITLE,
          operationId: SCRATCH_OPERATION_ID,
          headers: plan.headers,
          body: describeBody(plan.body),
          bodyKind: plan.body?.kind,
          validation: "no_schema",
          statusText: response.statusText,
          responseHeaders: response.headers,
          responseBody: storedResponseBody(response),
        }),
      );
    } catch (error) {
      setRequestError(describeSendError(error, inTauri));
    } finally {
      setSending(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pad, vars, connection]);

  /** Scratch history only — spec-driven calls belong with their API. */
  const scratchHistory = useMemo(
    () => requests.filter((entry) => entry.operationId === SCRATCH_OPERATION_ID),
    [requests],
  );

  const replayScratch = useCallback(
    (entry: HistoryEntry) => {
      updatePad(padFromHistory(entry));
      setRequestError(null);
      setValidation(null);
      setResult(responseFromHistory(entry));
    },
    [updatePad],
  );

  const openScratch = useCallback(() => {
    setRoute("scratch");
    setResult(null);
    setValidation(null);
    setRequestError(null);
    setCurl(null);
  }, []);

  /**
   * Open a recorded call: restore the request *and* show what came back.
   *
   * Clicking history used to jump to the operation with the inputs restored but
   * an empty response pane, which loses the thing you clicked for. The recorded
   * response is re-rendered — including its schema check — and the entry stays
   * one Send away from being run again.
   */
  const doReplay = useCallback(
    (entry: HistoryEntry) => {
      if (!spec) return;
      const found = spec.operations.find((op) => op.id === entry.operationId);
      if (!found) {
        // Used to `return` silently, so clicking the row did nothing at all and
        // looked broken. A spec sync makes this ordinary rather than rare.
        setRequestError(
          `${entry.operationId} is no longer in this spec, so it can't be replayed. ` +
            `It was recorded on ${new Date(entry.at).toLocaleString()} and returned ${entry.status}.`,
        );
        setResult(null);
        setValidation(null);
        patchSettings({ inspectorOpen: true });
        return;
      }
      setOperation(found);
      // Path and query values live only inside the recorded URL; without pulling
      // them back out the form shows blank fields beside the response they
      // produced.
      const { pathParams, queryParams } = history.paramsFromEntry(entry, found.path);
      setReplay({ headers: entry.headers, body: entry.body, pathParams, queryParams });
      setViewingRecord(entry);
      setTab("operations");
      setView("operation");
      try {
        const parsed = new URL(entry.url);
        setServer(`${parsed.protocol}//${parsed.host}`);
      } catch {
        /* keep the current base URL */
      }

      const recorded = responseFromHistory(entry);
      if (!recorded) {
        // Recorded before responses were stored — say so instead of showing nothing.
        setResult(null);
        setValidation(null);
        setRequestError(
          `Recorded ${entry.status} in ${entry.ms}ms, but this entry predates response capture. Send again to see the body.`,
        );
        return;
      }

      setRequestError(null);
      setResult(recorded);

      const declared = declaredResponse(found.responses, entry.status, { ranges: false });
      setValidation(validateResponse(spec.doc, declared?.schema, recorded.json));
      patchSettings({ inspectorOpen: true });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [spec],
  );

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
    closeDialogs: () => {
      setShowOpen(false);
      setShowEnvs(false);
      setShowSwitcher(false);
    },
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
        onSignIn={() => {
          setOpenTab("spec0");
          setShowOpen(true);
        }}
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
              onClearHistory={() => {
                void history.clearHistory();
                setRequests([]);
              }}
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
                      /*
                       * Says plainly that these panes are a record, not a live
                       * result. Without it a replayed 200 from three weeks ago
                       * is indistinguishable from one just sent, and the request
                       * fields — restored from what was recorded — look like
                       * values the developer typed. Sending, or picking another
                       * operation, clears it.
                       */
                      <div className="record-bar" role="status">
                        <span className="record-bar-dot" aria-hidden="true" />
                        <span className="record-bar-text">
                          Showing a recorded request from{" "}
                          <strong>{history.relativeTime(viewingRecord.at)}</strong> — returned{" "}
                          <strong>{viewingRecord.status}</strong> in {viewingRecord.ms}ms
                          {viewingRecord.mock ? " from a mock" : ""}. Send to run it again.
                        </span>
                        <button
                          className="record-bar-close"
                          onClick={() => setViewingRecord(null)}
                          aria-label="Dismiss"
                          title="Dismiss"
                        >
                          ×
                        </button>
                      </div>
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
            setOpenTab("spec0");
            setShowOpen(true);
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
          onSession={(next) => {
            setSession(next);
            void saveSession(next);
          }}
          onOpenFile={() => void openFile()}
          onOpenUrl={(url) => void openUrl(url)}
          onOpenSpec0={(text, name, source, mock) => {
            void ingest(text, name, { kind: "spec0", ref: source }, mock);
          }}
          onTrySample={() => void ingest(SAMPLE_SPEC, SAMPLE_NAME, { kind: "sample", ref: "sample" })}
          onClose={() => {
            setShowOpen(false);
            setOpenTab("file");
          }}
        />
      )}

      <Updater />
    </div>
  );
}
