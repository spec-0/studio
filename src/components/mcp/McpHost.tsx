import { useEffect } from "react";
import { ensureBridge, loadMcpPrefs, startMcp } from "../../lib/mcpServer";
import { inTauri } from "../../lib/request";
import { AgentApprovalDialog } from "./AgentApprovalDialog";

/**
 * The always-mounted part of the local MCP server.
 *
 * Answers tool calls (the bridge), starts the server at launch, but only if
 * the user turned that on, and shows an agent's approval requests wherever the
 * developer is in the app. The controls live in {@link McpPanel}, shown in the
 * MCP tab and in Settings.
 */
export function McpHost() {
  useEffect(() => {
    if (!inTauri) return;
    let stopped = false;
    void ensureBridge();
    void loadMcpPrefs().then((prefs) => {
      // Off unless the user asked for it. A failure here stays quiet; the panel
      // shows the state when it's opened.
      if (!stopped && prefs.startOnLaunch) void startMcp(prefs).catch(() => undefined);
    });
    return () => {
      stopped = true;
    };
  }, []);
  return <AgentApprovalDialog />;
}
