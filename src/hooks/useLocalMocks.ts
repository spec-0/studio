import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LibraryEntry } from "../lib/library";
import type { InvalidRequests } from "../lib/localMock";
import {
  DEFAULT_LOCAL_MOCK_PREFS,
  ensureLocalMockBridge,
  forgetLocalMockSpecs,
  listLocalMocks,
  loadLocalMockPrefs,
  saveLocalMockPrefs,
  setLocalMockOptions,
  startLocalMock,
  stopLocalMock,
  type LocalMockPrefs,
} from "../lib/localMockServer";
import { inTauri } from "../lib/request";

/**
 * Local mocks: which APIs are being served on this computer, on which port, and
 * the actions. Rust holds the truth about what is running; this asks it after
 * every change rather than keeping its own copy.
 *
 * Nothing here starts a mock by itself.
 */
export function useLocalMocks() {
  const [running, setRunning] = useState<Record<string, number>>({});
  const [prefs, setPrefs] = useState<LocalMockPrefs>(DEFAULT_LOCAL_MOCK_PREFS);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);

  const sync = useCallback(async () => {
    const list = await listLocalMocks();
    setRunning(Object.fromEntries(list.map((mock) => [mock.id, mock.port])));
  }, []);

  useEffect(() => {
    if (!inTauri) return;
    // Answers requests for mocks still running from before a reload of the window.
    void ensureLocalMockBridge();
    void loadLocalMockPrefs().then((stored) => {
      setPrefs(stored);
      setLocalMockOptions({ invalid: stored.invalid });
    });
    void sync();
  }, [sync]);

  const start = useCallback(
    async (entry: LibraryEntry) => {
      setBusy(entry.id);
      setError(null);
      try {
        const status = await startLocalMock(entry.id, prefs.ports[entry.id]);
        if (prefs.ports[entry.id] !== status.port) {
          const next = { ...prefs, ports: { ...prefs.ports, [entry.id]: status.port } };
          setPrefs(next);
          await saveLocalMockPrefs(next);
        }
      } catch (caught) {
        setError({ id: entry.id, message: caught instanceof Error ? caught.message : String(caught) });
      } finally {
        await sync();
        setBusy(null);
      }
    },
    [prefs, sync],
  );

  const stop = useCallback(
    async (id: string) => {
      setBusy(id);
      setError(null);
      try {
        await stopLocalMock(id);
      } finally {
        await sync();
        setBusy(null);
      }
    },
    [sync],
  );

  const setInvalid = useCallback(
    (invalid: InvalidRequests) => {
      const next = { ...prefs, invalid };
      setPrefs(next);
      setLocalMockOptions({ invalid });
      void saveLocalMockPrefs(next);
    },
    [prefs],
  );

  const count = useMemo(() => Object.keys(running).length, [running]);

  return {
    sync,
    /** Library id → port, for every mock running now. */
    running,
    count,
    busy,
    error,
    invalid: prefs.invalid,
    setInvalid,
    start,
    stop,
    available: inTauri,
  };
}

/**
 * When the library changes, answer from the document it holds now, and stop the
 * mock of any API that was removed from it.
 */
export function useLocalMocksFollowLibrary(
  entries: LibraryEntry[],
  { running, sync }: Pick<ReturnType<typeof useLocalMocks>, "running" | "sync">,
) {
  const runningRef = useRef(running);
  runningRef.current = running;
  const loaded = useRef(false);
  useEffect(() => {
    forgetLocalMockSpecs();
    // Before the library has loaded there is nothing to compare against.
    if (entries.length) loaded.current = true;
    if (!loaded.current) return;
    const known = new Set(entries.map((entry) => entry.id));
    const orphans = Object.keys(runningRef.current).filter((id) => !known.has(id));
    if (orphans.length) void Promise.all(orphans.map((id) => stopLocalMock(id))).then(sync);
  }, [entries, sync]);
}
