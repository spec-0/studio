import { useCallback, useEffect, useState } from "react";
import type { SidebarTab } from "../components/Sidebar";
import { copyDestination, draftFromEntry, isScratch, type HistoryEntry } from "../lib/history";
import * as library from "../lib/library";
import type { LibraryEntry } from "../lib/library";
import { padFromHistory, type ScratchPad } from "../lib/scratch";
import { parseSpec, type OperationSpec, type ParsedSpec } from "../lib/spec";
import type { MainView, PrefillValues, Route } from "./useWorkspace";

/**
 * Reading recorded requests and copying them into new ones.
 *
 * A record is only ever shown read-only. "Copy to a new request" is the one
 * way back to an editor: it opens the operation (switching API if the record
 * belongs to another one) or the scratch pad, filled from the record, with a
 * note saying it's new.
 */
export function useHistoryRecords({
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
}: {
  entries: LibraryEntry[];
  current: LibraryEntry | null;
  spec: ParsedSpec | null;
  openEntry: (entry: LibraryEntry) => Promise<void>;
  setRoute: (route: Route) => void;
  setOperation: (op: OperationSpec) => void;
  setPrefill: (values: PrefillValues | null) => void;
  setServer: (server: string) => void;
  setTab: (tab: SidebarTab) => void;
  setView: (view: MainView) => void;
  setRecord: (entry: HistoryEntry | null) => void;
  setCopiedFrom: (at: string | null) => void;
  updatePad: (pad: ScratchPad) => void;
  clearResponse: (options?: { curl?: boolean }) => void;
}) {
  /** A copy waiting for its API to finish opening. */
  const [pendingCopy, setPendingCopy] = useState<HistoryEntry | null>(null);

  const libraryEntryFor = useCallback(
    (entry: HistoryEntry) =>
      isScratch(entry) || !entry.apiId ? null : (entries.find((e) => e.id === entry.apiId) ?? null),
    [entries],
  );

  /** The spec an entry's API has now — the open one if it's open, otherwise read from the library. */
  const specFor = useCallback(
    async (entry: HistoryEntry): Promise<ParsedSpec | null> => {
      const api = libraryEntryFor(entry);
      if (!api) return null;
      if (api.id === current?.id && spec) return spec;
      try {
        const text = await library.readSpecText(api.id);
        return text ? parseSpec(text, api.title) : null;
      } catch {
        return null;
      }
    },
    [libraryEntryFor, current?.id, spec],
  );

  const fillOperation = useCallback(
    (entry: HistoryEntry, parsed: ParsedSpec) => {
      const op = parsed.operations.find((o) => o.id === entry.operationId);
      if (!op) return;
      const draft = draftFromEntry(entry, op.path);
      setOperation(op);
      setPrefill({
        headers: draft.headers,
        body: draft.body,
        pathParams: draft.pathParams,
        queryParams: draft.queryParams,
      });
      if (draft.server) setServer(draft.server);
      setTab("operations");
      setView("operation");
      setRecord(null);
      clearResponse({ curl: true });
      setCopiedFrom(entry.at);
      setRoute("api");
    },
    [setOperation, setPrefill, setServer, setTab, setView, setRecord, clearResponse, setCopiedFrom, setRoute],
  );

  // Apply a copy once the API it belongs to has opened.
  useEffect(() => {
    if (!pendingCopy || !spec || current?.id !== pendingCopy.apiId) return;
    fillOperation(pendingCopy, spec);
    setPendingCopy(null);
  }, [pendingCopy, spec, current?.id, fillOperation]);

  const copyRecord = useCallback(
    (entry: HistoryEntry, destination: "operation" | "scratch") => {
      if (destination === "scratch") {
        updatePad(padFromHistory(entry));
        setRecord(null);
        clearResponse({ curl: true });
        setCopiedFrom(entry.at);
        setRoute("scratch");
        return;
      }
      const api = libraryEntryFor(entry);
      if (!api) return;
      if (api.id === current?.id && spec) {
        if (copyDestination(entry, spec).kind === "operation") fillOperation(entry, spec);
        return;
      }
      setPendingCopy(entry);
      void openEntry(api);
    },
    [libraryEntryFor, current?.id, spec, fillOperation, openEntry, updatePad, setRecord, clearResponse, setCopiedFrom, setRoute],
  );

  return { specFor, copyRecord };
}
