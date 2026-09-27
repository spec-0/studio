import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import * as library from "../lib/library";
import type { LibraryEntry } from "../lib/library";
import {
  currentStep,
  initialJourney,
  journeyReducer,
  pickTestOperation,
  type JourneyMock,
  type JourneyState,
  type JourneyTarget,
} from "../lib/mockJourney";
import { buildPublishRequest, type PublishResult } from "../lib/publish";
import { parseSpec, type OperationSpec, type ParsedSpec } from "../lib/spec";
import {
  absoluteMockUrl,
  adoptCliSession,
  createMock,
  getEntitlements,
  getMockApiKey,
  listMocks,
  listTeams,
  publishTeamApi,
  refreshMock,
  regenerateMockApiKey,
  SignInCancelled,
  signInViaBrowser,
  verify,
  DEFAULT_API_URL,
  type Session,
} from "../lib/spec0";
import { inTauri } from "../lib/request";
import { describeMockRefresh } from "../lib/sync";

/** The journey's target, read from a library entry. */
export function targetOf(entry: LibraryEntry, apiUrl: string): JourneyTarget {
  const url = absoluteMockUrl(apiUrl, entry.mockUrl);
  return {
    entryId: entry.id,
    title: entry.title,
    version: entry.version,
    sourceKind: entry.source.kind,
    apiId: library.spec0ApiIdOf(entry),
    mock: url
      ? { mockServerId: entry.mockServerId ?? null, url, apiKey: entry.mockApiKey ?? null }
      : null,
  };
}

const EMPTY_TARGET: JourneyTarget = {
  entryId: "",
  title: "",
  version: "",
  sourceKind: "file",
  apiId: null,
  mock: null,
};

/**
 * The "Create a mock server" journey: its state, and the calls each step makes.
 *
 * The decisions — which step is next, what an error means — are in
 * `lib/mockJourney`. This hook makes the calls, writes what they return into
 * the library, and points the address bar at the new mock.
 */
export function useMockJourney({
  session,
  updateSession,
  entries,
  setEntries,
  current,
  setCurrent,
  setServer,
  spec,
  operation,
  server,
  route,
  openEntry,
  showOperation,
  doSend,
  onMocksChanged,
}: {
  session: Session | null;
  updateSession: (next: Session | null) => void;
  entries: LibraryEntry[];
  setEntries: Dispatch<SetStateAction<LibraryEntry[]>>;
  current: LibraryEntry | null;
  setCurrent: Dispatch<SetStateAction<LibraryEntry | null>>;
  setServer: (url: string) => void;
  spec: ParsedSpec | null;
  operation: OperationSpec | null;
  server: string;
  route: string;
  openEntry: (entry: LibraryEntry) => Promise<void>;
  showOperation: (id: string) => void;
  doSend: () => Promise<void>;
  /** The org's mock list changed — the Mocks tab reloads. */
  onMocksChanged: () => void;
}) {
  /** Null when closed; "pick" when opened without an API (from the Mocks tab). */
  const [open, setOpen] = useState<null | "pick" | "journey">(null);
  const [state, dispatch] = useReducer(journeyReducer, initialJourney(EMPTY_TARGET, false));
  const [cliAvailable, setCliAvailable] = useState(false);
  /** Set after the mock was created here, so the done screen can say where requests go. */
  const [retargeted, setRetargeted] = useState(false);
  const [rebuildLines, setRebuildLines] = useState<string[] | null>(null);
  const pendingSend = useRef<{ opId: string; server: string } | null>(null);
  const apiUrl = session?.apiUrl ?? DEFAULT_API_URL;

  const refreshEntries = useCallback(
    (next: LibraryEntry[], entryId: string) => {
      setEntries(next);
      setCurrent((open) => (open?.id === entryId ? next.find((e) => e.id === entryId) ?? open : open));
    },
    [setEntries, setCurrent],
  );

  useEffect(() => {
    if (!open || !inTauri) return;
    void adoptCliSession().then((found) => setCliAvailable(Boolean(found)));
  }, [open]);

  // ── opening ──────────────────────────────────────────────────────────────────

  const start = useCallback(
    (entry: LibraryEntry) => {
      dispatch({ type: "reset", state: initialJourney(targetOf(entry, apiUrl), Boolean(session)) });
      setRetargeted(false);
      setRebuildLines(null);
      setOpen("journey");
    },
    [apiUrl, session],
  );

  /** From the Mocks tab: pick an API first. */
  const startPicking = useCallback(() => {
    setRetargeted(false);
    setRebuildLines(null);
    setOpen("pick");
  }, []);

  const close = useCallback(() => setOpen(null), []);

  // The session can change while the dialog is open (signed out elsewhere, or in here).
  useEffect(() => {
    if (open !== "journey") return;
    if (session && !state.signedIn && !state.error) dispatch({ type: "signedIn" });
    if (!session && state.signedIn) dispatch({ type: "signedOut" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, open]);

  // Once signed in: ask what the organisation may still create, and load teams
  // if the API still has to be published.
  useEffect(() => {
    if (open !== "journey" || !session || !state.signedIn) return;
    if (state.entitlements === undefined) {
      void getEntitlements(session)
        .then((value) => dispatch({ type: "entitlements", value }))
        .catch((error: unknown) => {
          // A 401 here means the session is gone; anything else just means "unknown".
          if ((error as { status?: number }).status === 401) {
            dispatch({ type: "failed", step: "signIn", error });
          } else {
            dispatch({ type: "entitlements", value: null });
          }
        });
    }
    if (!state.apiId && state.teams === null && !state.error) {
      void listTeams(session)
        .then((teams) => dispatch({ type: "teamsLoaded", teams }))
        .catch((error: unknown) => dispatch({ type: "failed", step: "team", error }));
    }
  }, [open, session, state.signedIn, state.entitlements, state.apiId, state.teams, state.error]);

  // A mock we know about without its key: fetch the key.
  useEffect(() => {
    if (open !== "journey" || !session || !state.signedIn) return;
    const mock = state.mock;
    if (!mock || mock.apiKey || !mock.mockServerId || state.busy) return;
    let cancelled = false;
    void getMockApiKey(session, mock.mockServerId)
      .then(async (key) => {
        if (cancelled || !key) return;
        refreshEntries(await library.setMockKeyFor(key.mockServerId, key.apiKey), state.target.entryId);
        dispatch({ type: "keyChanged", apiKey: key.apiKey });
      })
      .catch(() => {
        /* the paste field stays on screen */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, session, state.signedIn, state.mock?.mockServerId]);

  // ── steps ────────────────────────────────────────────────────────────────────

  const connect = useCallback(
    async (how: "cli" | "browser") => {
      dispatch({
        type: "busy",
        label: how === "cli" ? "Using your spec0 CLI sign-in…" : "Waiting for the browser…",
      });
      try {
        const next = how === "cli" ? await adoptCliSession() : await signInViaBrowser();
        if (!next) throw new Error("No spec0 CLI sign-in was found on this machine.");
        await verify(next);
        updateSession(next);
        dispatch({ type: "signedIn" });
      } catch (error) {
        if (error instanceof SignInCancelled) dispatch({ type: "signInCancelled" });
        else dispatch({ type: "failed", step: "signIn", error });
      }
    },
    [updateSession],
  );

  const chooseTeam = useCallback((teamId: string | null) => dispatch({ type: "chooseTeam", teamId }), []);

  const retryTeams = useCallback(() => dispatch({ type: "retryTeams" }), []);

  const publish = useCallback(
    async (name: string, version: string) => {
      if (!session) return;
      const entryId = state.target.entryId;
      dispatch({ type: "busy", label: "Publishing…" });
      try {
        const text = await library.readSpecText(entryId);
        if (!text) throw new Error("The stored document is missing. Refresh or re-add this API.");
        const result = await publishTeamApi<PublishResult>(
          session,
          buildPublishRequest({ text, name, team: state.teamId, version }),
        );
        if (!result.apiId) throw new Error("Spec0 didn't return the published API's id.");
        refreshEntries(await library.linkSpec0Api(entryId, result.apiId), entryId);
        dispatch({ type: "published", apiId: result.apiId });
      } catch (error) {
        dispatch({ type: "failed", step: "publish", error });
      }
    },
    [session, state.target.entryId, state.teamId, refreshEntries],
  );

  /** Point requests for this API at its mock. */
  const targetMock = useCallback(
    async (entryId: string, url: string) => {
      if (current?.id === entryId) {
        setServer(url);
      } else {
        refreshEntries(await library.saveApiState(entryId, { server: url }), entryId);
      }
    },
    [current?.id, setServer, refreshEntries],
  );

  const makeMock = useCallback(async () => {
    if (!session || !state.apiId) return;
    const { entryId, version } = state.target;
    dispatch({ type: "busy", label: "Creating the mock…" });
    try {
      const created = await createMock(session, state.apiId);
      if (!created.mockUrl) throw new Error("Spec0 didn't return the mock's address.");
      let apiKey = created.apiKey ?? null;
      if (!apiKey && created.mockServerId) {
        // An existing mock doesn't return its key on create; ask for it.
        apiKey = (await getMockApiKey(session, created.mockServerId).catch(() => null))?.apiKey ?? null;
      }
      const mock: JourneyMock = { mockServerId: created.mockServerId ?? null, url: created.mockUrl, apiKey };
      refreshEntries(
        await library.setMock(entryId, {
          mockUrl: mock.url,
          mockServerId: mock.mockServerId,
          mockApiKey: apiKey,
          mockSpecVersion: version || null,
        }),
        entryId,
      );
      await targetMock(entryId, mock.url);
      setRetargeted(true);
      dispatch({ type: "mockReady", mock });
      onMocksChanged();
    } catch (error) {
      dispatch({ type: "failed", step: "mock", error });
    }
  }, [session, state.apiId, state.target, refreshEntries, targetMock, onMocksChanged]);

  /** Paste a key by hand, when Spec0 wouldn't give it. */
  const saveKey = useCallback(
    async (apiKey: string) => {
      const entryId = state.target.entryId;
      refreshEntries(await library.setMock(entryId, { mockApiKey: apiKey }), entryId);
      dispatch({ type: "keyChanged", apiKey });
    },
    [state.target.entryId, refreshEntries],
  );

  /**
   * Find the mock's id when the entry only knows its URL (entries from before
   * the id was stored). Rebuilding and key actions need it.
   */
  const resolveMockId = useCallback(async (): Promise<string | null> => {
    if (state.mock?.mockServerId) return state.mock.mockServerId;
    if (!session || !state.apiId) return null;
    const found = (await listMocks(session)).find((row) => row.apiId === state.apiId)?.mockServerId ?? null;
    if (found) {
      const entryId = state.target.entryId;
      refreshEntries(await library.setMock(entryId, { mockServerId: found }), entryId);
      if (state.mock) dispatch({ type: "mockReady", mock: { ...state.mock, mockServerId: found } });
    }
    return found;
  }, [session, state.apiId, state.mock, state.target.entryId, refreshEntries]);

  const rebuild = useCallback(async () => {
    if (!session) return;
    dispatch({ type: "busy", label: "Rebuilding the mock…" });
    setRebuildLines(null);
    try {
      const id = await resolveMockId();
      if (!id) throw new Error("Studio doesn't know this mock's id. Re-pull the API from Spec0.");
      const result = await refreshMock(session, id);
      const entryId = state.target.entryId;
      refreshEntries(
        await library.setMock(entryId, {
          mockSpecVersion: result.specVersion ?? state.target.version,
          clearStale: true,
        }),
        entryId,
      );
      setRebuildLines(describeMockRefresh(result));
      dispatch({ type: "idle" });
    } catch (error) {
      dispatch({ type: "failed", step: "done", error });
    }
  }, [session, resolveMockId, state.target, refreshEntries]);

  const regenerateKey = useCallback(async () => {
    if (!session) return;
    dispatch({ type: "busy", label: "Making a new key…" });
    try {
      const id = await resolveMockId();
      if (!id) throw new Error("Studio doesn't know this mock's id. Re-pull the API from Spec0.");
      const key = await regenerateMockApiKey(session, id);
      refreshEntries(await library.setMockKeyFor(id, key.apiKey), state.target.entryId);
      dispatch({ type: "keyChanged", apiKey: key.apiKey });
    } catch (error) {
      dispatch({ type: "failed", step: "done", error });
    }
  }, [session, resolveMockId, state.target.entryId, refreshEntries]);

  /**
   * Open the API on a simple GET, aimed at the mock, and send it.
   *
   * Sent from an effect once the operation and address are on screen, so the
   * request is the one the user can see.
   */
  const sendTest = useCallback(async () => {
    const mock = state.mock;
    const entry = entries.find((row) => row.id === state.target.entryId);
    if (!mock || !entry) return;
    setOpen(null);

    let operations = current?.id === entry.id && spec ? spec.operations : null;
    if (!operations) {
      const text = await library.readSpecText(entry.id);
      operations = text ? parseSpec(text, entry.title).operations : [];
    }
    const op = pickTestOperation(operations);
    if (!op) return;

    pendingSend.current = { opId: op.id, server: mock.url };
    if (current?.id === entry.id) {
      setServer(mock.url);
      showOperation(op.id);
    } else {
      const next = await library.saveApiState(entry.id, { server: mock.url, lastOperationId: op.id, tab: "operations" });
      setEntries(next);
      const updated = next.find((row) => row.id === entry.id);
      if (updated) await openEntry(updated);
    }
  }, [state.mock, state.target.entryId, entries, current?.id, spec, setServer, showOperation, setEntries, openEntry]);

  useEffect(() => {
    const pending = pendingSend.current;
    if (!pending || route !== "api") return;
    if (operation?.id !== pending.opId || server !== pending.server) return;
    pendingSend.current = null;
    void doSend();
  }, [route, operation?.id, server, doSend]);

  return {
    open,
    state,
    view: currentStep(state),
    cliAvailable,
    retargeted,
    rebuildLines,
    start,
    startPicking,
    close,
    connect,
    chooseTeam,
    retryTeams,
    publish,
    makeMock,
    saveKey,
    rebuild,
    regenerateKey,
    sendTest,
  };
}

export type MockJourney = ReturnType<typeof useMockJourney>;
export type { JourneyState };
