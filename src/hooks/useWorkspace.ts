import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type { DocumentTab } from "../components/DocumentView";
import type { SidebarTab } from "../components/Sidebar";
import type { EnvironmentFile } from "../lib/env";
import { fingerprint, type HistoryEntry } from "../lib/history";
import * as library from "../lib/library";
import type { LibraryEntry } from "../lib/library";
import { initialAuth, type AuthState } from "../lib/request";
import type { OperationSpec, ParsedSpec } from "../lib/spec";

export type MainView = "operation" | "schema" | "graph" | "document";
export type Route = "library" | "api" | "scratch" | "history";

/** Values a new request starts from when it is copied from a recording. */
export interface PrefillValues {
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

  const [prefill, setPrefill] = useState<PrefillValues | null>(null);
  /**
   * The recorded request open in the work area, read-only, in place of the
   * editor. A record is never loaded into the editors — that made a response
   * from three weeks ago look exactly like one from three seconds ago.
   */
  const [record, setRecord] = useState<HistoryEntry | null>(null);
  /**
   * When the editor was filled by "Copy to a new request": the time of the
   * recording it came from. The editor says it's a new request until this is
   * dismissed, something is sent, or another operation is picked.
   */
  const [copiedFrom, setCopiedFrom] = useState<string | null>(null);

  const [server, setServer] = useState("");

  /** Which document a recorded check ran against — computed once per spec, not per send. */
  const specFingerprint = useMemo(() => (spec ? fingerprint(spec.sourceText) : undefined), [spec]);
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

      setPrefill(null);
      setRecord(null);
      setCopiedFrom(null);
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
  };
}
