import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { registerAgentApp, type AgentApp } from "../lib/agentApp";
import type { ConnectionSettings } from "../lib/connection";
import * as history from "../lib/history";
import type { HistoryEntry } from "../lib/history";
import type { LibraryEntry } from "../lib/library";
import type { Session } from "../lib/spec0";
import type { CollectionsApi } from "./useCollections";
import type { useLocalMocks } from "./useLocalMocks";

interface Live {
  entries: LibraryEntry[];
  vars: Record<string, string>;
  activeEnv: { id: string; name: string } | null;
  connection: ConnectionSettings;
  session: Session | null;
  localMocks: ReturnType<typeof useLocalMocks>;
  collections: CollectionsApi;
  setRequests: Dispatch<SetStateAction<HistoryEntry[]>>;
}

/**
 * Hands the agent tools (`src/lib/mcpAgent.ts`) the app as it is right now:
 * the active environment, connection settings, local mocks and collections.
 *
 * Registered once and read through a ref, so a tool always sees the latest
 * values without the registration changing on every render. Nothing here
 * listens for anything; the MCP server does that, and only when it's running.
 */
export function useAgentApp(live: Live) {
  const ref = useRef(live);
  ref.current = live;

  useEffect(() => {
    const app: AgentApp = {
      entries: () => ref.current.entries,
      vars: () => ref.current.vars,
      environment: () => ref.current.activeEnv,
      connection: () => ref.current.connection,
      session: () => ref.current.session,
      oauthToken: (entry) => ref.current.collections.tokenFor(entry),
      historyChanged: () => void history.loadHistory().then(ref.current.setRequests),
      localMocks: {
        running: () => ref.current.localMocks.running,
        start: (entry) => ref.current.localMocks.startOrThrow(entry),
        stop: (id) => ref.current.localMocks.stop(id),
      },
      collections: {
        list: () => ref.current.collections.agentActions.list(),
        add: (collection) => ref.current.collections.agentActions.add(collection),
        change: (id, change) => ref.current.collections.agentActions.change(id, change),
        run: (id, options) => ref.current.collections.run(id, options),
        runLogs: (id) => ref.current.collections.runLogs.runsFor(id),
        saveTo: (id, path) => ref.current.collections.agentActions.saveTo(id, path),
      },
    };
    registerAgentApp(app);
    return () => registerAgentApp(null);
  }, []);
}
