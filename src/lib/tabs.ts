import { draftKey } from "./drafts";

/**
 * Request tabs: the operations you have open, across APIs.
 *
 * Opening an operation (from the sidebar, a tab, History, a `spec0://` link or
 * anywhere else) opens its tab, or focuses the one already open. Tabs are
 * operations only; a collection step is edited in its collection.
 *
 * Closing a tab never loses anything: unsent changes live in the drafts
 * (`drafts.ts`), not in the tab, so the operation still shows its dot in the
 * sidebar and reopens as it was left.
 *
 * There are at most {@link TAB_LIMIT} tabs. Opening one more closes the one
 * used longest ago, skipping tabs with unsent changes; if every other tab has
 * unsent changes, none is closed and the strip goes over the limit rather than
 * closing one without asking.
 *
 * No React here; the hook is `src/hooks/useRequestTabs.ts`.
 */

export interface RequestTab {
  /** Same as the operation's draft key: `<apiId> <METHOD /path>`. */
  key: string;
  apiId: string;
  operationId: string;
  method: string;
  path: string;
  /** The API's title when the tab was opened; the library's current title is preferred when shown. */
  apiTitle: string;
  /** When it was last focused, on the tab list's own clock. Decides which tab the limit closes. */
  usedAt: number;
}

export interface TabsState {
  version: 1;
  tabs: RequestTab[];
  activeKey: string | null;
  /** Increases on every focus, so "used longest ago" survives a restart. */
  clock: number;
}

export const TAB_LIMIT = 20;

export const EMPTY_TABS: TabsState = { version: 1, tabs: [], activeKey: null, clock: 0 };

export interface TabTarget {
  apiId: string;
  operationId: string;
  method: string;
  path: string;
  apiTitle: string;
}

/**
 * Open a tab for an operation, or focus the one already open. New tabs go at
 * the end. `keep` says whether a tab has unsent changes, which the limit never
 * closes.
 */
export function openTab(
  state: TabsState,
  target: TabTarget,
  keep: (key: string) => boolean,
  limit: number = TAB_LIMIT,
): TabsState {
  const key = draftKey(target.apiId, target.operationId);
  const clock = state.clock + 1;
  const existing = state.tabs.find((tab) => tab.key === key);
  if (existing) {
    if (state.activeKey === key && existing.apiTitle === target.apiTitle) return state;
    return {
      ...state,
      clock,
      activeKey: key,
      tabs: state.tabs.map((tab) => (tab.key === key ? { ...tab, ...target, key, usedAt: clock } : tab)),
    };
  }
  let tabs = [...state.tabs, { ...target, key, usedAt: clock }];
  while (tabs.length > limit) {
    const evictable = tabs
      .filter((tab) => tab.key !== key && !keep(tab.key))
      .sort((a, b) => a.usedAt - b.usedAt)[0];
    if (!evictable) break;
    tabs = tabs.filter((tab) => tab.key !== evictable.key);
  }
  return { ...state, clock, activeKey: key, tabs };
}

/**
 * Close a tab. When it was the active one, the tab to its right becomes active
 * (or to its left, at the end), as in a browser; `next` is that tab, or null
 * when there is none left or the closed tab wasn't active.
 */
export function closeTab(state: TabsState, key: string): { state: TabsState; next: RequestTab | null } {
  const index = state.tabs.findIndex((tab) => tab.key === key);
  if (index < 0) return { state, next: null };
  const tabs = state.tabs.filter((tab) => tab.key !== key);
  if (state.activeKey !== key) return { state: { ...state, tabs }, next: null };
  const next = tabs[index] ?? tabs[index - 1] ?? null;
  return { state: { ...state, tabs, activeKey: next?.key ?? null }, next };
}

/** The tab `step` places along from the active one, wrapping at both ends. */
export function neighbourTab(state: TabsState, step: 1 | -1): RequestTab | null {
  if (!state.tabs.length) return null;
  const index = state.tabs.findIndex((tab) => tab.key === state.activeKey);
  if (index < 0) return step === 1 ? state.tabs[0] : state.tabs[state.tabs.length - 1];
  if (state.tabs.length === 1) return null;
  return state.tabs[(index + step + state.tabs.length) % state.tabs.length];
}

/** Drop tabs whose API left the library, or whose operation left the spec. */
export function dropTabs(state: TabsState, gone: (tab: RequestTab) => boolean): TabsState {
  const tabs = state.tabs.filter((tab) => !gone(tab));
  if (tabs.length === state.tabs.length) return state;
  const activeKey = tabs.some((tab) => tab.key === state.activeKey) ? state.activeKey : null;
  return { ...state, tabs, activeKey };
}

/** Read what was stored, dropping anything that doesn't look like a tab rather than failing. */
export function parseTabs(raw: unknown): TabsState {
  if (!raw || typeof raw !== "object") return EMPTY_TABS;
  const stored = raw as Partial<TabsState>;
  if (stored.version !== 1 || !Array.isArray(stored.tabs)) return EMPTY_TABS;
  const seen = new Set<string>();
  const tabs: RequestTab[] = [];
  for (const tab of stored.tabs) {
    if (!tab || typeof tab.apiId !== "string" || typeof tab.operationId !== "string") continue;
    const key = draftKey(tab.apiId, tab.operationId);
    if (seen.has(key)) continue;
    seen.add(key);
    tabs.push({
      key,
      apiId: tab.apiId,
      operationId: tab.operationId,
      method: typeof tab.method === "string" ? tab.method : "",
      path: typeof tab.path === "string" ? tab.path : "",
      apiTitle: typeof tab.apiTitle === "string" ? tab.apiTitle : "",
      usedAt: typeof tab.usedAt === "number" ? tab.usedAt : 0,
    });
  }
  const clock = Math.max(typeof stored.clock === "number" ? stored.clock : 0, ...tabs.map((tab) => tab.usedAt));
  const activeKey = tabs.some((tab) => tab.key === stored.activeKey) ? (stored.activeKey as string) : null;
  return { version: 1, tabs, activeKey, clock };
}
