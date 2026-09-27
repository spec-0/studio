import { useCallback, useEffect, useState } from "react";
import { writeStore, STORE } from "../lib/store";

export interface Settings {
  dark: boolean;
  inspectorOpen: boolean;
  /** Width of the schema detail panel in the graph view. */
  graphPanel: number;
}

export const DEFAULT_SETTINGS: Settings = { dark: true, inspectorOpen: true, graphPanel: 340 };

/**
 * App-wide display settings: theme, response pane, graph panel width.
 *
 * Every patch is written straight to the settings store, and the theme is
 * applied to the document root whenever it changes.
 */
export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", settings.dark);
  }, [settings.dark]);

  const patchSettings = useCallback(
    (patch: Partial<Settings>) =>
      setSettings((prev) => {
        const next = { ...prev, ...patch };
        void writeStore(STORE.settings, next);
        return next;
      }),
    [],
  );

  return { settings, setSettings, patchSettings };
}
