import { useCallback, useEffect, useRef, useState } from "react";
import type { RunEvent } from "../lib/collectionRun";
import {
  addRun,
  appendEvent,
  clearRuns,
  EMPTY_RUN_LOGS,
  exportRunLog,
  keepCollections,
  loadRunLogs,
  saveRunLogs,
  startLog,
  type RunLog,
  type RunLogStore,
} from "../lib/runLog";

/** Which part of a collection is on screen: its steps, or its past runs. */
export type CollectionPane = "steps" | "runs";

/**
 * Collection run logs: the run in progress (in memory), past runs (in
 * `run-logs.json`, redacted, capped), and which one is on screen.
 */
export function useRunLogs(collectionIds: readonly string[], loaded: boolean) {
  const [store, setStore] = useState<RunLogStore>(EMPTY_RUN_LOGS);
  const [live, setLive] = useState<Record<string, RunLog>>({});
  const [pane, setPane] = useState<Record<string, CollectionPane>>({});
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [storeLoaded, setStoreLoaded] = useState(false);
  const latest = useRef(store);
  latest.current = store;
  const lives = useRef<Record<string, RunLog>>({});

  useEffect(() => {
    void loadRunLogs().then((stored) => {
      latest.current = stored;
      setStore(stored);
      setStoreLoaded(true);
    });
  }, []);

  const commit = useCallback((next: RunLogStore) => {
    if (next === latest.current) return;
    latest.current = next;
    setStore(next);
    void saveRunLogs(next);
  }, []);

  // A deleted collection's runs go with it.
  const idsKey = collectionIds.join("|");
  useEffect(() => {
    if (!loaded || !storeLoaded) return;
    commit(keepCollections(latest.current, new Set(collectionIds)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, loaded, storeLoaded, commit]);

  /** Every event of every run goes through here, in order. */
  const onEvent = useCallback(
    (run: { collection: { id: string; name: string }; runId: string; environment: string | null }, event: RunEvent) => {
      const id = run.collection.id;
      const current =
        event.type === "run_started" || !lives.current[id] || lives.current[id].id !== run.runId
          ? startLog(run.runId, run.collection, run.environment, event.at)
          : lives.current[id];
      const next = appendEvent(current, event);
      // A new run is what the Runs pane should show, not one picked earlier.
      if (event.type === "run_started") {
        setSelected((prev) => {
          if (!(id in prev)) return prev;
          const rest = { ...prev };
          delete rest[id];
          return rest;
        });
      }
      lives.current = { ...lives.current, [id]: next };
      setLive(lives.current);
      if (event.type === "run_finished") {
        commit(addRun(latest.current, next));
        const rest = { ...lives.current };
        delete rest[id];
        lives.current = rest;
        setLive(rest);
      }
    },
    [commit],
  );

  /** A collection's runs, newest first, with the one in progress on top. */
  const runsFor = useCallback(
    (collectionId: string): RunLog[] => {
      const past = store.runs[collectionId] ?? [];
      const now = live[collectionId];
      return now ? [now, ...past.filter((run) => run.id !== now.id)] : past;
    },
    [store, live],
  );

  const show = useCallback((collectionId: string, runId?: string) => {
    setPane((prev) => ({ ...prev, [collectionId]: "runs" }));
    if (runId) setSelected((prev) => ({ ...prev, [collectionId]: runId }));
  }, []);

  const clear = useCallback(
    (collectionId: string) => {
      commit(clearRuns(latest.current, collectionId));
      setSelected((prev) => {
        const next = { ...prev };
        delete next[collectionId];
        return next;
      });
    },
    [commit],
  );

  return {
    runsFor,
    /** Whether a run of this collection is being logged right now. */
    liveRun: useCallback((collectionId: string) => live[collectionId] ?? null, [live]),
    onEvent,
    pane: useCallback((collectionId: string): CollectionPane => pane[collectionId] ?? "steps", [pane]),
    setPane: useCallback(
      (collectionId: string, next: CollectionPane) => setPane((prev) => ({ ...prev, [collectionId]: next })),
      [],
    ),
    selectedRun: useCallback((collectionId: string) => selected[collectionId] ?? null, [selected]),
    selectRun: useCallback(
      (collectionId: string, runId: string) => setSelected((prev) => ({ ...prev, [collectionId]: runId })),
      [],
    ),
    show,
    clear,
    exportRun: exportRunLog,
  };
}

export type RunLogsApi = ReturnType<typeof useRunLogs>;
