import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SchemaGraphView } from "@spec0/schema-graph/react";
import {
  Cable,
  ChevronDown,
  Play,
  ChevronLeft,
  Layers,
  Moon,
  FileText,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Sun,
  Waypoints,
  X,
} from "lucide-react";
import { Sidebar, type SidebarTab } from "./components/Sidebar";
import { DocumentView, type DocumentTab } from "./components/DocumentView";
import { readGitInfo, type GitInfo } from "./lib/git";
import { PublishDialog } from "./components/PublishDialog";
import { canPublish, whyNotPublishable, type PublishResult } from "./lib/publish";
import { OperationView, type RequestValues } from "./components/OperationView";
import { Inspector } from "./components/Inspector";
import { SchemaView } from "./components/SchemaView";
import { UrlBar, type Target } from "./components/UrlBar";
import { Brand } from "./components/Logo";
import { MockKeyBar } from "./components/MockKeyBar";
import { ConnectionChip } from "./components/ConnectionChip";
import { Resizer } from "./components/Resizer";
import { EnvironmentsDialog } from "./components/EnvironmentsDialog";
import { ConnectionDialog } from "./components/ConnectionDialog";
import { OAuthDialog } from "./components/OAuthDialog";
import { RunDialog } from "./components/RunDialog";
import { OpenDialog } from "./components/OpenDialog";
import { Library } from "./components/Library";
import { ScratchView } from "./components/ScratchView";
import { ApiSwitcher } from "./components/ApiSwitcher";
import { Updater } from "./components/UpdateDialog";
import { fileName, shortcut } from "./lib/platform";
import { parseSpec, type OperationSpec, type ParsedSpec } from "./lib/spec";
import {
  appFetch,
  buildPlan,
  inTauri,
  send,
  describeBody,
  extensionFor,
  toCurl,
  type AuthState,
  type ResponseResult,
} from "./lib/request";
import { validateResponse, type ValidationResult } from "./lib/validate";
import {
  interpolate,
  loadEnvironments,
  newEnvironment,
  saveEnvironments,
  variableMap,
  withVariable,
  type EnvironmentFile,
} from "./lib/env";
import * as history from "./lib/history";
import type { HistoryEntry } from "./lib/history";
import * as library from "./lib/library";
import type { ApiSource, LibraryEntry } from "./lib/library";
import {
  awaitOAuthCallback,
  openExternal,
  pickSaveTarget,
  pickSpecFile,
  readStore,
  saveResponseTo,
  writeStore,
  STORE,
} from "./lib/store";
import {
  DEFAULT_CONNECTION,
  hostOf,
  isUnverified,
  loadConnection,
  saveConnection,
  transportFor,
  type ConnectionSettings,
} from "./lib/connection";
import {
  DEFAULT_API_URL,
  absoluteMockUrl,
  apiIdFromRef,
  getApiConsumers,
  consumersUrl,
  apiUrl,
  listTeams,
  publishTeamApi,
  type TeamSummary,
  type ApiConsumers,
  fetchTeamApiSpec,
  hasUpdate,
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
import {
  buildAuthorizeUrl,
  createChallenge,
  createVerifier,
  describeExpiry,
  exchangeAuthorizationCode,
  fetchClientCredentialsToken,
  isExpired,
  loadToken,
  refreshAccessToken,
  saveToken,
  type CachedToken,
  type OAuthConfig,
} from "./lib/oauth";
import {
  planRun,
  toMarkdown,
  type RunOptions,
  type RunResult,
} from "./lib/runner";
import { SAMPLE_NAME, SAMPLE_SPEC } from "./lib/sample";
import {
  describeImpact,
  diffSpecs,
  environmentSkew,
  isNoteworthy,
  mockIsBehind,
} from "./lib/sync";

type MainView = "operation" | "schema" | "graph" | "document";
type Route = "library" | "api" | "scratch";

interface Settings {
  dark: boolean;
  inspectorOpen: boolean;
  /** Width of the schema detail panel in the graph view. */
  graphPanel: number;
}

const DEFAULT_SETTINGS: Settings = { dark: true, inspectorOpen: true, graphPanel: 340 };

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

  // Publishing this document to spec0. The only write path in the app,
  // so its failures are surfaced rather than swallowed the way the read-side
  // decorations are.
  const [showPublish, setShowPublish] = useState(false);
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [teamsError, setTeamsError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<PublishResult | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);
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

  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [envFile, setEnvFile] = useState<EnvironmentFile>({ environments: [], activeId: null });
  const [requests, setRequests] = useState<HistoryEntry[]>([]);
  const [session, setSession] = useState<Session | null>(null);

  const [showOpen, setShowOpen] = useState(false);
  const [openTab, setOpenTab] = useState<"file" | "url" | "spec0">("file");
  const [showEnvs, setShowEnvs] = useState(false);
  const [showConnection, setShowConnection] = useState(false);
  const [showRun, setShowRun] = useState(false);
  const [runResults, setRunResults] = useState<RunResult[]>([]);
  const [runningOp, setRunningOp] = useState<OperationSpec | null>(null);
  const [runScope, setRunScope] = useState("");
  const runCancel = useRef(false);
  const [showOAuth, setShowOAuth] = useState<{ prefill?: string } | null>(null);
  const [oauthToken, setOauthToken] = useState<CachedToken | null>(null);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionSettings>(DEFAULT_CONNECTION);
  const [showSwitcher, setShowSwitcher] = useState(false);
  const [checking, setChecking] = useState(false);
  const [pad, setPad] = useState<ScratchPad>(EMPTY_PAD);
  const [syncReport, setSyncReport] = useState<{ title: string; lines: string[] } | null>(null);

  const values = useRef<RequestValues>({ pathParams: {}, queryParams: {}, headerParams: {}, body: "" });
  const onValuesChange = useCallback((next: RequestValues) => {
    values.current = next;
  }, []);
  const fileInput = useRef<HTMLInputElement>(null);
  const sendRef = useRef<() => void>(() => {});

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

  useEffect(() => {
    document.documentElement.classList.toggle("dark", settings.dark);
  }, [settings.dark]);

  const saveConnectionSettings = useCallback((next: ConnectionSettings) => {
    setConnection(next);
    void saveConnection(next);
  }, []);

  const patchSettings = (patch: Partial<Settings>) =>
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      void writeStore(STORE.settings, next);
      return next;
    });

  const activeEnv = envFile.environments.find((env) => env.id === envFile.activeId) ?? null;
  const vars = useMemo(() => variableMap(activeEnv), [activeEnv]);
  /**
   * Resolve on read, not just on import: entries added before mock URLs were
   * absolutised still hold a bare path, and a stale library row shouldn't leave
   * the target selector inserting something that can't be sent.
   */
  const mockUrl = useMemo(
    () => absoluteMockUrl(session?.apiUrl ?? DEFAULT_API_URL, current?.mockUrl) ?? null,
    [current?.mockUrl, session?.apiUrl],
  );
  /**
   * How to authenticate against the hosted mock.
   *
   * The platform session token is only offered when the mock is served from the
   * *same origin* we already send that token to. A mock URL is data that arrived
   * over the network; attaching the user's credentials to whatever host it names
   * would be a credential leak, so the origin check is a hard gate, not a tidy-up.
   */
  /** True when the mock serves an older contract than the spec we hold. */
  const mockBehind = useMemo(() => mockIsBehind(current ?? {}), [current]);

  /** Is the request about to be sent somewhere we've stopped verifying? */
  const unverifiedTarget = useMemo(
    () => isUnverified(connection, interpolate(server, vars)),
    [connection, server, vars],
  );

  const mock = useMemo(() => {
    if (!mockUrl) return null;
    let sameOrigin = false;
    try {
      sameOrigin = Boolean(session) && new URL(mockUrl).origin === new URL(session!.apiUrl).origin;
    } catch {
      sameOrigin = false;
    }
    return {
      url: mockUrl,
      key: current?.mockApiKey,
      bearer: sameOrigin ? session?.token : undefined,
    };
  }, [mockUrl, current?.mockApiKey, session]);

  /** True while the address bar is aimed at the mock — drives the key prompt. */
  const targetingMock = useMemo(() => {
    if (!mockUrl) return false;
    const resolved = interpolate(server, vars).replace(/\/$/, "");
    return resolved !== "" && resolved === mockUrl.replace(/\/$/, "");
  }, [server, vars, mockUrl]);

  /**
   * Keep an ad-hoc base URL as a `baseUrl` variable in the active environment,
   * creating a Local one if there isn't one.
   *
   * Typing a URL stays the zero-setup path; this is only for wanting it back
   * tomorrow. It writes a plain variable rather than a special field, so there is
   * exactly one notion of environment.
   */
  const saveTarget = useCallback((url: string) => {
    setEnvFile((prev) => {
      const base =
        prev.environments.find((env) => env.id === prev.activeId) ?? newEnvironment("Local");
      const updated = withVariable(base, "baseUrl", url);
      const exists = prev.environments.some((env) => env.id === updated.id);
      const next = {
        activeId: updated.id,
        environments: exists
          ? prev.environments.map((env) => (env.id === updated.id ? updated : env))
          : [...prev.environments, updated],
      };
      void saveEnvironments(next);
      return next;
    });
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

      const dropped = result.customVariantsDropped ?? [];
      setSyncReport({
        title: `${entry.title} mock`,
        lines: [
          result.refreshed
            ? `Rebuilt against ${result.specVersion ?? "the current spec"} — same URL and key`
            : "Already serving the current spec",
          ...(result.customVariantsCarriedOver
            ? [`${result.customVariantsCarriedOver} custom response variant(s) carried over`]
            : []),
          ...(dropped.length
            ? [`${dropped.length} custom variant(s) dropped — their operation is gone: ${dropped.slice(0, 3).join(", ")}`]
            : []),
        ],
      });
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(null);
    }
  }, [session, current]);

  useEffect(() => {
    if (!current?.id) {
      setOauthToken(null);
      return;
    }
    void loadToken(current.id, envFile.activeId).then(setOauthToken);
  }, [current?.id, envFile.activeId]);

  /**
   * Obtain a token, by whichever grant is configured.
   *
   * Both grants end the same way — a token in the cache keyed by API and
   * environment — so the caller doesn't branch on which one ran.
   */
  const acquireToken = useCallback(
    async (config: OAuthConfig) => {
      if (!current) return;
      setOauthBusy(true);
      setOauthError(null);
      try {
        const transport = transportFor(connection, config.tokenUrl);
        let token: CachedToken;
        if (config.grant === "client_credentials") {
          token = await fetchClientCredentialsToken(config, vars, transport);
        } else {
          const verifier = createVerifier();
          const challenge = await createChallenge(verifier);
          const state = createVerifier(24);
          const port = 8127;
          const redirectUri = `http://127.0.0.1:${port}/callback`;

          // Reuses the loopback listener built for spec0 sign-in — a webview
          // can't hold a socket, and this is the same shape of handshake.
          const waiting = awaitOAuthCallback(port, 180);
          await openExternal(buildAuthorizeUrl(config, challenge, state, redirectUri));
          const params = await waiting;

          if (params.state !== state) {
            // A mismatched state means the response didn't come from the
            // request we made — refusing is the whole point of sending it.
            throw new Error("The authorization response didn't match this request. Try again.");
          }
          if (params.error) {
            throw new Error(params.error_description ?? params.error);
          }
          if (!params.code) throw new Error("The browser came back without an authorization code.");
          token = await exchangeAuthorizationCode(
            config,
            params.code,
            verifier,
            redirectUri,
            vars,
            transport,
          );
        }
        await saveToken(current.id, envFile.activeId, token);
        setOauthToken(token);
      } catch (error) {
        setOauthError(error instanceof Error ? error.message : String(error));
      } finally {
        setOauthBusy(false);
      }
    },
    [current, connection, vars, envFile.activeId],
  );

  /**
   * The token to send, renewed first if it's close to expiring.
   *
   * Silent by design: a refresh that works is not news, and stopping to tell the
   * user would defeat the point of storing a refresh token.
   */
  const usableToken = useCallback(async (): Promise<string> => {
    const config = current?.oauth;
    if (!current || !config) return "";
    let token = oauthToken ?? (await loadToken(current.id, envFile.activeId));
    if (token && isExpired(token) && token.refreshToken) {
      try {
        token = await refreshAccessToken(config, token, vars, transportFor(connection, config.tokenUrl));
        await saveToken(current.id, envFile.activeId, token);
        setOauthToken(token);
      } catch {
        // A refresh that fails leaves the old token in place: it may still work,
        // and a 401 from the API is a clearer signal than a refresh error here.
      }
    }
    return token?.accessToken ?? "";
  }, [current, oauthToken, envFile.activeId, vars, connection]);

  /**
   * Run a set of operations and check each response against the spec.
   *
   * Sequential on purpose: a burst of concurrent requests at an internal service
   * is a load test nobody asked for. Results stream in as they land, so a long
   * run is watchable and can be stopped with partial results kept — an aborted
   * run that discarded what it had learned would be worse than not stopping.
   */
  const runOperations = useCallback(
    async (operations: OperationSpec[], options: RunOptions, scope: string) => {
      if (!spec) return;
      runCancel.current = false;
      setRunScope(scope);
      setRunResults([]);
      const runId = `run_${Date.now().toString(36)}`;
      const planned = planRun(operations, vars, options);
      const collected: RunResult[] = [];

      for (const item of planned) {
        if (runCancel.current) break;
        if (item.skip) {
          collected.push({ operation: item.operation, verdict: "skipped", skip: item.skip });
          setRunResults([...collected]);
          continue;
        }

        setRunningOp(item.operation);
        try {
          const plan = buildPlan(
            item.operation,
            server,
            item.pathParams,
            item.queryParams,
            {},
            auth,
            "",
            vars,
            mock,
          );
          const response = await send(plan, {
            ...transportFor(connection, plan.url),
            jar: current?.id,
          });
          const declared =
            item.operation.responses.find((r) => r.status === String(response.status)) ??
            item.operation.responses.find((r) => r.status === `${Math.floor(response.status / 100)}XX`) ??
            item.operation.responses.find((r) => r.status === "default");
          const verdict = validateResponse(spec.doc, declared?.schema, response.json);
          collected.push({
            operation: item.operation,
            verdict: verdict.status,
            status: response.status,
            ms: response.ms,
            validation: verdict,
          });

          await history.record({
            method: item.operation.method,
            path: item.operation.path,
            url: plan.url,
            status: response.status,
            ms: response.ms,
            bytes: response.bytes,
            specTitle: spec.title,
            operationId: item.operation.id,
            headers: plan.headers,
            body: describeBody(plan.body),
            bodyKind: plan.body?.kind,
            validation: verdict.status,
            mock: Boolean(mockUrl && plan.url.startsWith(mockUrl.replace(/\/$/, ""))),
            statusText: response.statusText,
            responseHeaders: response.headers,
            responseBody: response.binary ? "(binary — not stored)" : response.bodyText,
            runId,
          });
        } catch (error) {
          collected.push({
            operation: item.operation,
            verdict: "error",
            error: error instanceof Error ? error.message : String(error),
          });
        }
        setRunResults([...collected]);
      }

      setRunningOp(null);
      setRequests(await history.loadHistory());
    },
    [spec, server, auth, vars, mock, mockUrl, connection, current?.id],
  );

  const saveMockKey = useCallback(
    async (key: string) => {
      if (!current) return;
      const next = await library.setMock(current.id, { mockApiKey: key });
      setEntries(next);
      setCurrent(next.find((entry) => entry.id === current.id) ?? current);
    },
    [current],
  );

  /**
   * What the address bar can point at.
   *
   * Targets belong to the API — its declared servers, its hosted mock, the platform
   * environments it's deployed to — plus whatever the user types.
   *
   * *Client* environments are deliberately absent: they supply values, not
   * destinations. A platform environment is the opposite thing with an
   * unfortunately similar name — an actual place the API runs, reported by spec0,
   * so it belongs here and its variables do not.
   *
   * None of these is ever auto-selected. The initial value stays the spec's own
   * first server, because that is the document's declaration rather than a choice
   * made on the developer's behalf; where a request goes is theirs to pick.
   */
  const targets = useMemo(() => {
    const list: Target[] = [];
    for (const url of spec?.servers ?? []) {
      let label = url;
      try {
        const parsed = new URL(url);
        label = parsed.host + (parsed.pathname === "/" ? "" : parsed.pathname);
      } catch {
        /* a templated server URL — show it verbatim */
      }
      list.push({ label, url, kind: "server" });
    }
    if (mockUrl) list.push({ label: "Mock server", url: mockUrl, kind: "mock" });
    // Order is the platform's — its promotion order — and is preserved as received.
    for (const env of current?.environments ?? []) {
      list.push({ label: env.name, url: env.url, kind: "env" });
    }
    return list.filter((t, i, all) => all.findIndex((o) => o.url === t.url) === i);
  }, [spec, mockUrl, current?.environments]);

  /**
   * The environment currently being targeted, if any.
   *
   * Matched on URL rather than tracked as separate state, so typing an environment's
   * URL by hand is recognised as that environment — which is what a developer means
   * when they do it.
   */
  const activeEnvTarget = useMemo(() => {
    const resolved = interpolate(server, vars).replace(/\/$/, "");
    if (!resolved) return null;
    return (
      (current?.environments ?? []).find((env) => env.url.replace(/\/$/, "") === resolved) ?? null
    );
  }, [current?.environments, server, vars]);

  /**
   * The environment serves a different version than the spec we hold.
   *
   * Worth saying plainly, because it explains a whole class of confusing results: a
   * request built from 1.5.0's schema against a host still running 1.4.0 can fail in
   * ways that look like the client is wrong.
   */
  const envVersionSkew = useMemo(
    () => environmentSkew(activeEnvTarget, spec?.version),
    [activeEnvTarget, spec?.version],
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

      const scheme =
        parsed.securitySchemes.find((s) => s.name === state.authScheme) ?? parsed.securitySchemes[0];
      setAuth(
        scheme
          ? {
              schemeName: scheme.name,
              value: "",
              type: scheme.type,
              httpScheme: scheme.scheme,
              in: scheme.in,
              paramName: scheme.paramName,
            }
          : null,
      );
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
      const marks: Record<string, library.AvailableUpdate | undefined> = {};
      for (const entry of entries) {
        if (entry.source.kind !== "spec0") continue;
        const apiId = apiIdFromRef(entry.source.ref);
        if (!apiId) continue;
        const found = upstream.get(apiId);
        marks[entry.id] = hasUpdate(entry, found)
          ? {
              version: found?.version,
              updatedAt: found?.updatedAt,
              checkedAt: new Date().toISOString(),
            }
          : undefined;
      }
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

      const declared =
        operation.responses.find((r) => r.status === String(response.status)) ??
        operation.responses.find((r) => r.status === `${Math.floor(response.status / 100)}XX`) ??
        operation.responses.find((r) => r.status === "default");
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
          mock: Boolean(mockUrl && plan.url.startsWith(mockUrl.replace(/\/$/, ""))),
          statusText: response.statusText,
          responseHeaders: response.headers,
          // A 40MB PDF must not end up in history.json. Record that it happened
          // and how big it was; the bytes are already held in a temp file.
          responseBody: response.binary
            ? `(${response.binary.contentType || "binary"} · ${response.binary.byteLength} bytes — not stored)`
            : response.bodyText,
        }),
      );
    } catch (error) {
      setRequestError(
        error instanceof Error
          ? `${error.message}${inTauri ? "" : "\n\n(Browser preview — probably CORS. The desktop build sends from Rust and isn't subject to it.)"}`
          : String(error),
      );
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
    const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
    const target = await pickSaveTarget(named ?? `response${extensionFor(contentType)}`);
    if (!target) return;
    try {
      await saveResponseTo(path, target);
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : String(error));
    }
  }, [result]);

  sendRef.current = () => void doSend();

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
          // A 40MB PDF must not end up in history.json. Record that it happened
          // and how big it was; the bytes are already held in a temp file.
          responseBody: response.binary
            ? `(${response.binary.contentType || "binary"} · ${response.binary.byteLength} bytes — not stored)`
            : response.bodyText,
        }),
      );
    } catch (error) {
      setRequestError(
        error instanceof Error
          ? `${error.message}${inTauri ? "" : "\n\n(Browser preview — probably CORS. The desktop build sends from Rust and isn't subject to it.)"}`
          : String(error),
      );
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
      if (entry.responseBody === undefined) {
        setResult(null);
        return;
      }
      let json: unknown;
      try {
        json = entry.responseBody ? JSON.parse(entry.responseBody) : undefined;
      } catch {
        json = undefined;
      }
      setResult({
        status: entry.status,
        statusText: entry.statusText ?? "",
        headers: entry.responseHeaders ?? {},
        bodyText: entry.responseBody,
        json,
        ms: entry.ms,
        bytes: entry.bytes,
      });
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

      if (entry.responseBody === undefined) {
        // Recorded before responses were stored — say so instead of showing nothing.
        setResult(null);
        setValidation(null);
        setRequestError(
          `Recorded ${entry.status} in ${entry.ms}ms, but this entry predates response capture. Send again to see the body.`,
        );
        return;
      }

      let json: unknown;
      try {
        json = entry.responseBody ? JSON.parse(entry.responseBody) : undefined;
      } catch {
        json = undefined;
      }
      setRequestError(null);
      setResult({
        status: entry.status,
        statusText: entry.statusText ?? "",
        headers: entry.responseHeaders ?? {},
        bodyText: entry.responseBody,
        json,
        ms: entry.ms,
        bytes: entry.bytes,
      });

      const declared =
        found.responses.find((r) => r.status === String(entry.status)) ??
        found.responses.find((r) => r.status === "default");
      setValidation(validateResponse(spec.doc, declared?.schema, json));
      patchSettings({ inspectorOpen: true });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [spec],
  );

  // ── shortcuts ────────────────────────────────────────────────────────────────

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key === "Enter") {
        event.preventDefault();
        sendRef.current();
      } else if (meta && event.key === "o") {
        event.preventDefault();
        setShowOpen(true);
      } else if (meta && event.key === "p") {
        event.preventDefault();
        if (entries.length) setShowSwitcher(true);
      } else if (meta && event.key === "e") {
        event.preventDefault();
        setShowEnvs(true);
      } else if (meta && event.key === "l") {
        event.preventDefault();
        goLibrary();
      } else if (meta && event.key === "\\") {
        event.preventDefault();
        patchSettings({ inspectorOpen: !settings.inspectorOpen });
      } else if (meta && ["1", "2", "3"].includes(event.key)) {
        event.preventDefault();
        setTab(event.key === "1" ? "operations" : event.key === "2" ? "schemas" : "history");
      } else if (meta && event.key === "d") {
        event.preventDefault();
        patchSettings({ dark: !settings.dark });
      } else if (event.key === "/" && document.activeElement?.tagName !== "INPUT") {
        event.preventDefault();
        document.getElementById("sidebar-search")?.focus();
      } else if (event.key === "Escape") {
        setShowOpen(false);
        setShowEnvs(false);
        setShowSwitcher(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.inspectorOpen, settings.dark, entries.length, goLibrary]);

  /**
   * Open the publish dialog, loading the org's teams as it opens.
   *
   * Signed out this routes to sign-in rather than hiding the action: a button
   * that disappears when you aren't signed in teaches people the feature isn't
   * there, in another form.
   */
  const startPublish = useCallback(() => {
    setPublishResult(null);
    setPublishError(null);
    setTeamsError(null);
    setShowPublish(true);
    if (!session) return;
    void listTeams(session)
      .then(setTeams)
      .catch(() => {
        setTeams([]);
        // Not fatal: publishing without a team is legal and lands the API in
        // the org's "Unassigned APIs" team.
        setTeamsError("Couldn't list teams — you can still publish as unassigned.");
      });
  }, [session]);

  const doPublish = useCallback(
    async (body: unknown) => {
      if (!session || !current) return;
      setPublishing(true);
      setPublishError(null);
      try {
        const result = await publishTeamApi<PublishResult>(session, body);
        setPublishResult(result);
        // The document now exists upstream; remember it so the entry stops
        // looking like a purely local file.
        if (result.apiId) {
          setEntries(await library.touchOpened(current.id));
        }
      } catch (error) {
        setPublishError(error instanceof Error ? error.message : String(error));
      } finally {
        setPublishing(false);
      }
    },
    [session, current],
  );

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

      <div className="titlebar" data-tauri-drag-region>
        <Brand compact />

        {onScratch && (
          <>
            <span className="rule" />
            <button className="icon-btn" onClick={goLibrary} title={`All APIs (${shortcut("L")})`} aria-label="Back to all APIs">
              <ChevronLeft size={16} />
            </button>
            <span className="api-switch static">
              <span className="spec-name">Scratch</span>
              <span className="tag">no spec</span>
            </span>
          </>
        )}

        {onApi && (
          <>
            <span className="rule" />
            <button className="icon-btn" onClick={goLibrary} title={`All APIs (${shortcut("L")})`} aria-label="Back to all APIs">
              <ChevronLeft size={16} />
            </button>
            <button className="api-switch" onClick={() => setShowSwitcher(true)} title={`Switch API (${shortcut("P")})`}>
              <span className="spec-name">{spec?.title}</span>
              {spec?.version && <span className="spec-version">{spec.version}</span>}
              <ChevronDown size={13} className="chev" />
            </button>
            {current?.source.kind === "spec0" && <span className="tag ok">spec0</span>}
          </>
        )}
        <span className="spacer" />

        <ConnectionChip
          session={session}
          onClick={() => {
            setOpenTab("spec0");
            setShowOpen(true);
          }}
        />

        <button
          className={`icon-btn${connection.trusted.some((t) => t.insecure) ? " warn" : ""}`}
          onClick={() => setShowConnection(true)}
          title="Connection — certificates, proxy, timeout, cookies"
          aria-label="Connection settings"
        >
          <Cable size={16} />
        </button>

        <div className="env-picker" title={`Environment (${shortcut("E")})`}>
          <Layers size={13} />
          <select
            value={envFile.activeId ?? ""}
            onChange={(event) => {
              const next = { ...envFile, activeId: event.target.value || null };
              setEnvFile(next);
              void saveEnvironments(next);
            }}
          >
            <option value="">No environment</option>
            {envFile.environments.map((env) => (
              <option key={env.id} value={env.id}>
                {env.name}
              </option>
            ))}
          </select>
          <button className="icon-btn tight" onClick={() => setShowEnvs(true)} aria-label="Edit environments">
            <Plus size={13} />
          </button>
        </div>

        {onScratch && (
          <button
            className="icon-btn"
            onClick={() => patchSettings({ inspectorOpen: !settings.inspectorOpen })}
            title={`Response pane (${shortcut("\\")})`}
            aria-label="Toggle response pane"
          >
            {settings.inspectorOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
          </button>
        )}

        {onApi && (
          <>
            <button
              className="icon-btn"
              onClick={() => setShowRun(true)}
              title="Run against the spec"
              aria-label="Run against the spec"
            >
              <Play size={16} />
            </button>
            <button
              className={`icon-btn${showDocument ? " on" : ""}`}
              onClick={() => setView(showDocument ? "operation" : "document")}
              title="The document"
              aria-label="The document"
            >
              <FileText size={16} />
            </button>
            <button
              className={`icon-btn${showGraph ? " on" : ""}`}
              onClick={() => setView(showGraph ? "operation" : "graph")}
              title="Schema graph"
              aria-label="Schema graph"
            >
              <Waypoints size={16} />
            </button>
            <button
              className="icon-btn"
              onClick={() => patchSettings({ inspectorOpen: !settings.inspectorOpen })}
              title={`Response pane (${shortcut("\\")})`}
              aria-label="Toggle response pane"
            >
              {settings.inspectorOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
            </button>
          </>
        )}
        <button
          className="icon-btn"
          onClick={() => patchSettings({ dark: !settings.dark })}
          title={`${settings.dark ? "Light" : "Dark"} theme (${shortcut("D")})`}
          aria-label="Toggle theme"
        >
          {settings.dark ? <Sun size={16} /> : <Moon size={16} />}
        </button>
        {/* The library screen carries its own Add button — don't offer it twice. */}
        {onApi && (
          <button className="btn primary" onClick={() => setShowOpen(true)}>
            <Plus size={13} /> Add API
          </button>
        )}
      </div>

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
          <div className="statusbar">
            <span>Scratch · one ad-hoc request, not saved</span>
            {activeEnv && <span>env: {activeEnv.name}</span>}
            <span style={{ marginLeft: "auto" }}>
              {inTauri ? "requests via Rust · no CORS" : "browser preview · CORS applies"}
            </span>
            {result && (
              <span>
                {result.status} · {result.ms}ms
              </span>
            )}
          </div>
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
                <div className="split graph-split">
                  {/* The canvas keeps every pixel the panel isn't using — the detail
                      panel is a narrow, draggable, dismissible sidecar, not a second
                      half of the screen. */}
                  <div className="graph-wrap">
                    <SchemaGraphView
                      key={spec!.sourceName}
                      spec={spec!.doc}
                      initialSchema={graphFocus ?? undefined}
                      height="100%"
                      hidePanel
                      onSelectSchema={setGraphFocus}
                    />
                  </div>
                  {graphFocus && (
                    <>
                      <Resizer
                        width={settings.graphPanel}
                        onChange={(graphPanel) => patchSettings({ graphPanel })}
                        min={260}
                        max={620}
                      />
                      <section
                        className="pane detail"
                        style={{ width: settings.graphPanel, flex: `0 0 ${settings.graphPanel}px` }}
                      >
                        <div className="detail-head">
                          <span className="meta">Schema</span>
                          <span className="spacer" />
                          <button
                            className="icon-btn tight"
                            onClick={() => setGraphFocus(null)}
                            title="Close panel"
                            aria-label="Close schema panel"
                          >
                            <X size={14} />
                          </button>
                        </div>
                        <SchemaView
                          spec={spec!}
                          name={graphFocus}
                          onSelectSchema={setGraphFocus}
                          onSelectOperation={(id) => {
                            const found = spec!.operations.find((op) => op.id === id);
                            if (found) {
                              setOperation(found);
                              setTab("operations");
                              setView("operation");
                            }
                          }}
                        />
                      </section>
                    </>
                  )}
                </div>
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
                    onSelectOperation={(id) => {
                      const found = spec!.operations.find((op) => op.id === id);
                      if (found) {
                        setOperation(found);
                        setTab("operations");
                        setView("operation");
                      }
                    }}
                  />
                ) : (
                  <div className="empty">
                    <p>This spec declares no component schemas.</p>
                  </div>
                ))}
            </div>
          </div>

          <div className="statusbar">
            <span>
              {spec!.operations.length} operations · {spec!.schemas.length} schemas · {spec!.tags.length} tags
            </span>
            {activeEnv && <span>env: {activeEnv.name}</span>}
            {session && <span>spec0: {session.orgName}</span>}
            <span style={{ marginLeft: "auto" }}>
              {inTauri ? "requests via Rust · no CORS" : "browser preview · CORS applies"}
            </span>
            {result && (
              <span>
                {result.status} · {result.ms}ms
              </span>
            )}
          </div>
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
          onClear={() => {
            void saveToken(current.id, envFile.activeId, null);
            setOauthToken(null);
          }}
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
          onCancel={() => {
            runCancel.current = true;
          }}
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
          onSave={(next) => {
            setEnvFile(next);
            void saveEnvironments(next);
          }}
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
