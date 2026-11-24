import { useCallback, useRef, useState } from "react";
import {
  activeScratch,
  addScratch,
  duplicateScratch,
  EMPTY_SCRATCH,
  removeScratch,
  saveScratch,
  selectScratch,
  updateScratch,
  type ScratchPad,
  type ScratchState,
} from "../lib/scratch";

/**
 * The scratch requests (rules in `src/lib/scratch.ts`). Every change is saved,
 * the way a text buffer is; there is no Save button.
 */
export function useScratch() {
  const [state, setState] = useState<ScratchState>(EMPTY_SCRATCH);
  const [loaded, setLoaded] = useState(false);
  const latest = useRef(state);
  latest.current = state;

  const commit = useCallback((next: ScratchState) => {
    if (next === latest.current) return next;
    latest.current = next;
    setState(next);
    void saveScratch(next);
    return next;
  }, []);

  /** What was on disk, at start. */
  const restore = useCallback((stored: ScratchState) => {
    latest.current = stored;
    setState(stored);
    setLoaded(true);
  }, []);

  return {
    state,
    loaded,
    active: activeScratch(state),
    restore,
    /** Start a request (filled from `from`, or empty) and show it. Returns its id. */
    add: useCallback(
      (from?: ScratchPad) => commit(addScratch(latest.current, from)).activeId as string,
      [commit],
    ),
    update: useCallback((id: string, pad: ScratchPad) => void commit(updateScratch(latest.current, id, pad)), [commit]),
    select: useCallback((id: string) => void commit(selectScratch(latest.current, id)), [commit]),
    duplicate: useCallback((id: string) => commit(duplicateScratch(latest.current, id)).activeId, [commit]),
    remove: useCallback((id: string) => commit(removeScratch(latest.current, id)), [commit]),
  };
}
