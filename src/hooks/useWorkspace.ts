import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { DocumentTab } from "../components/DocumentView";
import type { SidebarTab } from "../components/Sidebar";
import type { EnvironmentFile } from "../lib/env";
import type { HistoryEntry } from "../lib/history";
import * as library from "../lib/library";
import type { LibraryEntry } from "../lib/library";
import { initialAuth, type AuthState } from "../lib/request";
import type { OperationSpec, ParsedSpec } from "../lib/spec";

export type MainView = "operation" | "schema" | "graph" | "document";
export type Route = "library" | "api" | "scratch";

/** Values restored into the request form from a history entry. */
export interface ReplayValues {
  headers: Record<string, string>;
  body?: string;
  pathParams?: Record<string, string>;
  queryParams?: Record<string, string>;
}

/**
 * The open API and where you are in it: which screen, which operation or
 * schema, the address bar, the auth scheme, and the document text.
 *
 * Where you were in each API is saved as you move, and restored when that API
 * opens again.
 */
export function useWorkspace(
  activeEnvId: string | null,
  setEnvFile: Dispatch<SetStateAction<EnvironmentFile>>,
) {
  const [route, setRoute] = useState<Route>("library");
  const [current, setCurrent] = useState<LibraryEntry | null>(null);
  const [spec, setSpec] = useState<ParsedSpec | null>(null);

  const [tab, setTab] = useState<SidebarTab>("operations");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<MainView>("operation");
  const [operation, setOperation] = useState<OperationSpec | null>(null);
  const [schemaName, setSchemaName] = useState<string | null>(null);
  const [graphFocus, setGraphFocus] = useState<string | null>(null);

  // The document itself: the text as imported. The two facts about it that
  // Studio can't read out of the spec are in useDocumentFacts.
  const [docText, setDocText] = useState("");
  const [docTab, setDocTab] = useState<DocumentTab>("reference");

  const [replay, setReplay] = useState<ReplayValues | null>(null);
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

  // Remember where you were in each API, so coming back doesn't mean re-entering everything.
  useEffect(() => {
    if (route !== "api" || !current) return;
    void library.saveApiState(current.id, {
      server,
      envId: activeEnvId,
      lastOperationId: operation?.id ?? null,
      tab,
      authScheme: auth?.schemeName ?? null,
      docTab,
    });
  }, [route, current, server, activeEnvId, operation, tab, auth?.schemeName, docTab]);

  /**
   * Show a parsed spec, restoring where you were in it last time.
   *
   * Only the workspace part of opening; the caller also clears the response
   * pane and the document facts.
   */
  const showSpec = useCallback(
    (parsed: ParsedSpec, entry: LibraryEntry, text: string) => {
      const state = entry.state ?? {};
      setSpec(parsed);
      setCurrent(entry);
      setRoute("api");

      // Keep the bytes, not just the parse — the Raw tab shows the document
      // that was imported, and the Reference tab renders the same string, so
      // the two can never disagree about what the spec says.
      setDocText(text);
      setDocTab(state.docTab ?? "reference");

      const restoredOperation =
        parsed.operations.find((op) => op.id === state.lastOperationId) ?? parsed.operations[0] ?? null;
      setOperation(restoredOperation);
      setSchemaName(parsed.schemas[0]?.name ?? null);
      setTab(state.tab ?? "operations");
      setView(state.tab === "schemas" ? "schema" : "operation");
      setServer(state.server ?? parsed.servers[0] ?? "");
      if (state.envId !== undefined && state.envId !== activeEnvId) {
        setEnvFile((prev) => ({ ...prev, activeId: state.envId ?? null }));
      }

      setReplay(null);
      setAuth(initialAuth(parsed.securitySchemes, state.authScheme));
    },
    [activeEnvId, setEnvFile],
  );

  /** Close the open API and go back to the library. */
  const closeApi = useCallback(() => {
    setCurrent(null);
    setSpec(null);
    setRoute("library");
  }, []);

  return {
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
  };
}
