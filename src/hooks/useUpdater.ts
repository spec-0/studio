import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_UPDATE_PREFS,
  checkForUpdate,
  currentVersion,
  installUpdate,
  loadUpdatePrefs,
  onCheckRequested,
  onUpdateProgress,
  saveUpdatePrefs,
  type AvailableUpdate,
  type UpdatePrefs,
  type UpdateProgress,
} from "../lib/appUpdates";
import { loadConnection } from "../lib/connection";
import { inTauri } from "../lib/request";

export type UpdatePhase =
  | { kind: "checking" }
  | { kind: "current" }
  | { kind: "available"; update: AvailableUpdate }
  | { kind: "installing"; update: AvailableUpdate }
  | { kind: "error"; message: string };

/**
 * Updates to Studio itself: the dialog's state, the optional check at start,
 * and the "check when Studio starts" setting.
 *
 * A check runs when the menu item is picked, when "Check for updates now" is
 * pressed in Settings, or at start only if the user turned that on. A check at
 * start that finds nothing, or fails, stays silent: nobody asked to see it.
 */
export function useUpdater() {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<UpdatePhase>({ kind: "checking" });
  const [prefs, setPrefs] = useState<UpdatePrefs>(DEFAULT_UPDATE_PREFS);
  const [version, setVersion] = useState<string | null>(null);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  // Only the most recent check may change what the dialog shows.
  const latest = useRef(0);

  const check = useCallback(async (quiet: boolean) => {
    const id = ++latest.current;
    if (!quiet) {
      setOpen(true);
      setPhase({ kind: "checking" });
    }
    try {
      const update = await checkForUpdate(await loadConnection());
      if (id !== latest.current) return;
      if (update) {
        setPhase({ kind: "available", update });
        setOpen(true);
      } else if (!quiet) {
        setPhase({ kind: "current" });
      }
    } catch (error) {
      if (!quiet && id === latest.current) {
        setPhase({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      }
    }
  }, []);

  useEffect(() => {
    // Read the setting in the browser preview too, so Settings shows it.
    let stopped = false;
    const unlisten: Array<() => void> = [];
    void loadUpdatePrefs().then((loaded) => {
      if (stopped) return;
      setPrefs(loaded);
      if (inTauri && loaded.checkOnStart) void check(true);
    });
    if (!inTauri) {
      return () => {
        stopped = true;
      };
    }
    void onCheckRequested(() => void check(false)).then((stop) =>
      stopped ? stop() : unlisten.push(stop),
    );
    void onUpdateProgress(setProgress).then((stop) => (stopped ? stop() : unlisten.push(stop)));
    void currentVersion().then(setVersion);
    return () => {
      stopped = true;
      unlisten.forEach((stop) => stop());
    };
  }, [check]);

  const setCheckOnStart = useCallback((checkOnStart: boolean) => {
    setPrefs((prev) => {
      const next = { ...prev, checkOnStart };
      void saveUpdatePrefs(next);
      return next;
    });
  }, []);

  const install = useCallback(async (update: AvailableUpdate) => {
    setProgress(null);
    setPhase({ kind: "installing", update });
    try {
      await installUpdate(); // relaunches on success, so this rarely returns
    } catch (error) {
      setPhase({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  const installing = phase.kind === "installing";
  const close = useCallback(() => {
    if (!installing) setOpen(false);
  }, [installing]);

  return { open, phase, prefs, version, progress, check, install, setCheckOnStart, close };
}

export type Updater = ReturnType<typeof useUpdater>;
