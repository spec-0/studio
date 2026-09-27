import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_MCP_PREFS,
  loadMcpPrefs,
  mcpStatus,
  newToken,
  saveMcpPrefs,
  startMcp,
  stopMcp,
  validPort,
  type McpPrefs,
  type McpStatus,
} from "../lib/mcpServer";

/**
 * The local MCP server's state for the panel: running or not, on which port,
 * the token, and the actions. Rust holds the truth about whether it's running;
 * this asks rather than remembering, so two panels can't disagree.
 */
export function useMcpServer() {
  const [prefs, setPrefs] = useState<McpPrefs>(DEFAULT_MCP_PREFS);
  const [status, setStatus] = useState<McpStatus>({ running: false, port: null });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let live = true;
    void Promise.all([loadMcpPrefs(), mcpStatus()]).then(([stored, current]) => {
      if (!live) return;
      setPrefs(stored);
      setStatus(current);
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, []);

  const run = useCallback(async (work: () => Promise<McpStatus>) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await work());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setStatus(await mcpStatus());
    } finally {
      setBusy(false);
    }
  }, []);

  const start = useCallback(() => run(() => startMcp(prefs)), [run, prefs]);
  const stop = useCallback(() => run(stopMcp), [run]);

  const update = useCallback(
    async (change: Partial<McpPrefs>, restart: boolean) => {
      const next = { ...prefs, ...change };
      setPrefs(next);
      await saveMcpPrefs(next);
      if (restart && status.running) await run(() => startMcp(next));
    },
    [prefs, status.running, run],
  );

  /** A new token; the old one stops working at once if the server is running. */
  const regenerateToken = useCallback(() => update({ token: newToken() }, true), [update]);

  const setPort = useCallback(
    (port: number) => {
      if (!validPort(port)) {
        setError("Choose a port from 1024 to 65535.");
        return;
      }
      void update({ port }, true);
    },
    [update],
  );

  const setStartOnLaunch = useCallback((value: boolean) => update({ startOnLaunch: value }, false), [update]);

  return {
    loaded,
    prefs,
    status,
    error,
    busy,
    start,
    stop,
    regenerateToken,
    setPort,
    setStartOnLaunch,
    /** The port it's on differs from the one asked for: the first was taken. */
    movedPort: status.running && status.port !== null && status.port !== prefs.port,
  };
}
