/**
 * Where you are in the app, as plain data: the screen (`Route`), the tab in the
 * top bar that screen belongs to, and the four views of an open API.
 *
 * No React here, so the rules can be tested directly. The state that uses them
 * is in `src/hooks/useNavigation.ts`.
 */

/** Every screen the window can show. */
export type Route =
  | "library"
  | "api"
  | "scratch"
  | "history"
  | "mocks"
  | "mcp"
  | "settings";

/** The text tabs on the left of the top bar. */
export type TopTab = "apis" | "history" | "mocks" | "mcp";

export const TOP_TABS: ReadonlyArray<{ id: TopTab; label: string }> = [
  { id: "apis", label: "APIs" },
  { id: "history", label: "History" },
  { id: "mocks", label: "Mocks" },
  { id: "mcp", label: "MCP" },
];

/** The views of an open API, shown as tabs under the top bar. */
export type ApiSection = "operations" | "schemas" | "graph" | "document";

export const API_SECTIONS: ReadonlyArray<{ id: ApiSection; label: string; key: string }> = [
  { id: "operations", label: "Operations", key: "1" },
  { id: "schemas", label: "Schemas", key: "2" },
  { id: "graph", label: "Graph", key: "3" },
  { id: "document", label: "Document", key: "4" },
];

/** The sections of the Settings page, in the order they're listed. */
export type SettingsSectionId = "account" | "network" | "updates" | "appearance" | "mcp" | "data";

export const SETTINGS_SECTIONS: ReadonlyArray<{ id: SettingsSectionId; label: string }> = [
  { id: "account", label: "Account & Spec0" },
  { id: "network", label: "Network" },
  { id: "updates", label: "Updates" },
  { id: "appearance", label: "Appearance" },
  { id: "mcp", label: "MCP" },
  { id: "data", label: "Data & privacy" },
];

/** The screens that belong to the APIs tab: the library, an open API, and the scratch pad. */
export function isApisRoute(route: Route): boolean {
  return route === "library" || route === "api" || route === "scratch";
}

/** Which top-bar tab is selected on a screen. Settings belongs to none of them. */
export function topTabOf(route: Route): TopTab | null {
  if (isApisRoute(route)) return "apis";
  if (route === "history" || route === "mocks" || route === "mcp") return route;
  return null;
}

/**
 * Where a top-bar tab goes.
 *
 * Coming back to APIs from another tab returns to what you were doing there,
 * the open API or the scratch pad, so a trip to History doesn't lose your
 * place. Choosing APIs while already on it goes to the list of all APIs.
 */
export function routeForTopTab(
  tab: TopTab,
  from: Route,
  lastApisRoute: Route,
  hasOpenApi: boolean,
): Route {
  if (tab !== "apis") return tab;
  if (isApisRoute(from)) return "library";
  if (lastApisRoute === "api" && !hasOpenApi) return "library";
  return isApisRoute(lastApisRoute) ? lastApisRoute : "library";
}

/** The API tab for ⌘/Ctrl+1–4, or null for any other key. */
export function sectionForKey(key: string): ApiSection | null {
  return API_SECTIONS.find((section) => section.key === key)?.id ?? null;
}

/**
 * The tab that arrow keys, Home and End move to in a tab list, following the
 * WAI-ARIA tabs pattern. Wraps at both ends. Null for any other key.
 */
export function nextTab<T>(
  ids: readonly T[],
  current: T,
  key: string,
  orientation: "horizontal" | "vertical" = "horizontal",
): T | null {
  if (!ids.length) return null;
  const index = Math.max(0, ids.indexOf(current));
  const back = orientation === "horizontal" ? "ArrowLeft" : "ArrowUp";
  const forward = orientation === "horizontal" ? "ArrowRight" : "ArrowDown";
  if (key === back) return ids[(index - 1 + ids.length) % ids.length];
  if (key === forward) return ids[(index + 1) % ids.length];
  if (key === "Home") return ids[0];
  if (key === "End") return ids[ids.length - 1];
  return null;
}
