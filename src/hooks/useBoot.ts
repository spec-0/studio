import { useEffect } from "react";
import { loadConnection, type ConnectionSettings } from "../lib/connection";
import { loadEnvironments, type EnvironmentFile } from "../lib/env";
import * as history from "../lib/history";
import type { HistoryEntry } from "../lib/history";
import * as library from "../lib/library";
import type { LibraryEntry } from "../lib/library";
import { loadScratch, type ScratchPad } from "../lib/scratch";
import { loadSession, type Session } from "../lib/spec0";
import { readStore, STORE } from "../lib/store";
import { DEFAULT_SETTINGS, type Settings } from "./useSettings";

/**
 * Load everything the app keeps on disk, once, at start.
 *
 * The order matters: environments load before history is scrubbed, because
 * that is when the secret values to strip are known.
 */
export function useBoot(set: {
  settings: (value: Settings) => void;
  envFile: (value: EnvironmentFile) => void;
  requests: (value: HistoryEntry[]) => void;
  session: (value: Session | null) => void;
  entries: (value: LibraryEntry[]) => void;
  pad: (value: ScratchPad) => void;
  connection: (value: ConnectionSettings) => void;
}) {
  useEffect(() => {
    void (async () => {
      set.settings(await readStore<Settings>(STORE.settings, DEFAULT_SETTINGS));
      set.envFile(await loadEnvironments());
      // Secrets are known now; strip any that older versions wrote into history.
      await history.scrubHistory();
      set.requests(await history.loadHistory());
      set.session(await loadSession());
      set.entries(await library.loadLibrary());
      set.pad(await loadScratch());
      set.connection(await loadConnection());
    })();
    // Runs once. The setters passed in are React state setters, which never change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
