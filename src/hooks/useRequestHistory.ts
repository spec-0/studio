import { useCallback, useMemo, useState } from "react";
import * as history from "../lib/history";
import type { HistoryEntry } from "../lib/history";
import { SCRATCH_OPERATION_ID } from "../lib/scratch";

/** Recorded requests, newest first, as loaded from and written to history.json. */
export function useRequestHistory() {
  const [requests, setRequests] = useState<HistoryEntry[]>([]);

  const clearHistory = useCallback(() => {
    void history.clearHistory();
    setRequests([]);
  }, []);

  /** Scratch history only. Spec-driven calls belong with their API. */
  const scratchHistory = useMemo(
    () => requests.filter((entry) => entry.operationId === SCRATCH_OPERATION_ID),
    [requests],
  );

  return { requests, setRequests, clearHistory, scratchHistory };
}
