import { useCallback, useEffect, useState } from "react";
import { onSettingsRequested } from "../lib/appMenu";
import {
  isApisRoute,
  routeForTopTab,
  topTabOf,
  type Route,
  type SettingsSectionId,
  type TopTab,
} from "../lib/navigation";

interface Options {
  route: Route;
  setRoute: (route: Route) => void;
  /** An API is open, so the APIs tab can return to it. */
  hasOpenApi: boolean;
}

/**
 * The top bar's tabs and the Settings page.
 *
 * The screen itself is `route` in `useWorkspace`; this adds what the top bar
 * needs on top of it: which tab is selected, where the APIs tab returns to,
 * and which Settings section is open. Settings… in the native menu opens the
 * page too.
 */
export function useNavigation({ route, setRoute, hasOpenApi }: Options) {
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>("account");
  /** A host to pre-fill in Network settings, when arriving from the address bar. */
  const [suggestHost, setSuggestHost] = useState<string | null>(null);
  /** The last screen under the APIs tab, so coming back doesn't lose your place. */
  const [lastApisRoute, setLastApisRoute] = useState<Route>("library");

  useEffect(() => {
    if (isApisRoute(route)) setLastApisRoute(route);
  }, [route]);

  const goTop = useCallback(
    (tab: TopTab) => setRoute(routeForTopTab(tab, route, lastApisRoute, hasOpenApi)),
    [route, lastApisRoute, hasOpenApi, setRoute],
  );

  const openSettings = useCallback(
    (section?: SettingsSectionId, options?: { host?: string | null }) => {
      if (section) setSettingsSection(section);
      setSuggestHost(options?.host ?? null);
      setRoute("settings");
    },
    [setRoute],
  );

  // Settings… in the app menu (macOS) or the File menu (Windows, Linux).
  useEffect(() => {
    let stopped = false;
    let stop: (() => void) | null = null;
    void onSettingsRequested(() => openSettings()).then((unlisten) => {
      if (stopped) unlisten();
      else stop = unlisten;
    });
    return () => {
      stopped = true;
      stop?.();
    };
  }, [openSettings]);

  return {
    topTab: topTabOf(route),
    goTop,
    lastApisRoute,
    settingsSection,
    setSettingsSection,
    suggestHost,
    openSettings,
  };
}
