import { useCallback, useEffect, useRef, useState } from "react";
import { setMenuClosesTab } from "../lib/appMenu";
import type { LibraryEntry } from "../lib/library";
import type { Route } from "../lib/navigation";
import { paneOwner } from "../lib/responsePane";
import type { OperationSpec, ParsedSpec } from "../lib/spec";
import { readStore, writeStore, STORE } from "../lib/store";
import {
  closeTab,
  dropTabs,
  EMPTY_TABS,
  neighbourTab,
  openTab,
  parseTabs,
  type RequestTab,
  type TabsState,
} from "../lib/tabs";
import type { OpenFocus } from "./useLibrary";

/**
 * The request tabs: which operations are open, across APIs, and moving
 * between them (the rules are in `src/lib/tabs.ts`).
 *
 * Whatever operation the editor shows gets a tab, however it got there, so the
 * sidebar, History's "Copy to a new request", `spec0://` links and the schema
 * view's links all open tabs without knowing about them.
 */
export function useRequestTabs({
  route,
  current,
  spec,
  operation,
  entries,
  hasUnsent,
  openEntry,
  selectOperation,
  goLibrary,
  clearResponse,
}: {
  route: Route;
  current: LibraryEntry | null;
  spec: ParsedSpec | null;
  operation: OperationSpec | null;
  entries: LibraryEntry[];
  hasUnsent: (key: string) => boolean;
  openEntry: (entry: LibraryEntry, focus?: OpenFocus) => Promise<void>;
  /** Show an operation of the API that is already open. */
  selectOperation: (op: OperationSpec) => void;
  /** Where closing the last tab goes. */
  goLibrary: () => void;
  clearResponse: (options: { owner: string | null }) => void;
}) {
  const [state, setState] = useState<TabsState>(EMPTY_TABS);
  const loaded = useRef(false);
  const latest = useRef(state);
  latest.current = state;

  useEffect(() => {
    let cancelled = false;
    void readStore<unknown>(STORE.tabs, null).then((raw) => {
      if (cancelled) return;
      const stored = parseTabs(raw);
      loaded.current = true;
      // A tab opened while the file was loading stays, and stays active.
      setState((now) => {
        const tabs = [...stored.tabs.filter((tab) => !now.tabs.some((t) => t.key === tab.key)), ...now.tabs];
        return {
          version: 1,
          tabs,
          activeKey: now.activeKey ?? stored.activeKey,
          clock: Math.max(stored.clock, now.clock),
        };
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (loaded.current) void writeStore(STORE.tabs, state);
  }, [state]);

  // The operation on screen always has a tab.
  const onScreen = route === "api" && current && spec && operation ? operation : null;
  useEffect(() => {
    if (!onScreen || !current) return;
    setState((now) =>
      openTab(
        now,
        {
          apiId: current.id,
          operationId: onScreen.id,
          method: onScreen.method,
          path: onScreen.path,
          apiTitle: current.title,
        },
        hasUnsent,
      ),
    );
    // hasUnsent only matters when a tab is added.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onScreen, current?.id, current?.title]);

  // An operation that has left the spec loses its tab when the API opens.
  useEffect(() => {
    if (!spec || !current) return;
    const ids = new Set(spec.operations.map((op) => op.id));
    setState((now) => dropTabs(now, (tab) => tab.apiId === current.id && !ids.has(tab.operationId)));
  }, [spec, current]);

  /** Show a tab's operation, opening its API first if another one is open. */
  const activate = useCallback(
    (tab: RequestTab) => {
      if (current?.id === tab.apiId && spec) {
        const op = spec.operations.find((o) => o.id === tab.operationId);
        if (op) {
          selectOperation(op);
          return;
        }
        setState((now) => dropTabs(now, (t) => t.key === tab.key));
        return;
      }
      const entry = entries.find((e) => e.id === tab.apiId);
      if (!entry) {
        setState((now) => dropTabs(now, (t) => t.key === tab.key));
        return;
      }
      void openEntry(entry, { operationId: tab.operationId });
    },
    [current?.id, spec, entries, selectOperation, openEntry],
  );

  const close = useCallback(
    (key: string) => {
      const { state: next, next: following } = closeTab(latest.current, key);
      const closed = latest.current.tabs.find((tab) => tab.key === key);
      const wasActive = latest.current.activeKey === key;
      setState(next);
      if (closed) clearResponse({ owner: paneOwner("api", closed.apiId, closed.operationId) });
      // Closing the tab on screen shows its neighbour, or the library after the last one.
      if (wasActive && route === "api") {
        if (following) activate(following);
        else goLibrary();
      }
    },
    [route, activate, goLibrary, clearResponse],
  );

  const step = useCallback(
    (direction: 1 | -1) => {
      const target = neighbourTab(latest.current, direction);
      if (target) activate(target);
    },
    [activate],
  );

  /** The tab the editor is showing, when the tab strip is on screen. */
  const activeKey = route === "api" ? state.activeKey : null;

  // On macOS, ⌘W closes this tab while there is one, and the window otherwise.
  const tabOnScreen = activeKey !== null;
  useEffect(() => {
    void setMenuClosesTab(tabOnScreen);
  }, [tabOnScreen]);

  return {
    tabs: state.tabs,
    activeKey,
    activate,
    close,
    next: useCallback(() => step(1), [step]),
    previous: useCallback(() => step(-1), [step]),
    /** An API left the library: its tabs go too. */
    forgetApi: useCallback((apiId: string) => {
      setState((now) => dropTabs(now, (tab) => tab.apiId === apiId));
    }, []),
  };
}
