import { useSyncExternalStore } from "react";
import { agentChatPanelOpen, subscribeAgentChatPanel } from "../lib/agentChatPanel";

/** Whether the chat panel is open, for the panel and the status bar button. */
export function useAgentChatPanelOpen(): boolean {
  return useSyncExternalStore(subscribeAgentChatPanel, agentChatPanelOpen);
}
