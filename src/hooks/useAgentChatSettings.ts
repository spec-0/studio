import { useCallback, useEffect, useState } from "react";
import { errorText } from "../lib/acpClient";
import { chooseCommand, clearCommand, listAgents, splitArgs, type AgentId, type AgentInfo } from "../lib/acpProcess";
import {
  AGENT_CHAT_PREFS_EVENT,
  DEFAULT_AGENT_CHAT_PREFS,
  loadAgentChatPrefs,
  saveAgentChatPrefs,
  type AgentChatPrefs,
} from "../lib/agentChat";

/**
 * Which agent the chat panel uses, where it works, and what's installed. Used
 * by Settings and by the panel; a change in one reaches the other through
 * `AGENT_CHAT_PREFS_EVENT`.
 */
export function useAgentChatSettings() {
  const [prefs, setPrefsState] = useState<AgentChatPrefs>(DEFAULT_AGENT_CHAT_PREFS);
  const [loaded, setLoaded] = useState(false);
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [defaultWorkspace, setDefaultWorkspace] = useState("");
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const reload = () =>
      void loadAgentChatPrefs().then((stored) => {
        setPrefsState(stored);
        setLoaded(true);
      });
    reload();
    window.addEventListener(AGENT_CHAT_PREFS_EVENT, reload);
    return () => window.removeEventListener(AGENT_CHAT_PREFS_EVENT, reload);
  }, []);

  const setPrefs = useCallback(async (change: Partial<AgentChatPrefs>) => {
    const next = { ...(await loadAgentChatPrefs()), ...change };
    setPrefsState(next);
    await saveAgentChatPrefs(next);
    window.dispatchEvent(new Event(AGENT_CHAT_PREFS_EVENT));
  }, []);

  /** Look for agents again. Rust searches the usual install places each time. */
  const findAgents = useCallback(async () => {
    setSearching(true);
    setError(null);
    try {
      const found = await listAgents();
      setAgents(found.agents);
      setDefaultWorkspace(found.defaultWorkspace);
    } catch (caught) {
      setError(`Couldn't look for agents: ${errorText(caught)}`);
    } finally {
      setSearching(false);
    }
  }, []);

  /** Set the program for an agent by hand. Studio asks the user natively before saving it. */
  const choose = useCallback(
    async (agent: AgentId, program: string, args: string): Promise<boolean> => {
      setError(null);
      try {
        const confirmed = await chooseCommand(agent, program, splitArgs(args));
        if (confirmed) await findAgents();
        return confirmed;
      } catch (caught) {
        setError(errorText(caught));
        return false;
      }
    },
    [findAgents],
  );

  const forget = useCallback(
    async (agent: AgentId) => {
      setError(null);
      try {
        await clearCommand(agent);
        await findAgents();
      } catch (caught) {
        setError(errorText(caught));
      }
    },
    [findAgents],
  );

  return { prefs, loaded, setPrefs, agents, defaultWorkspace, searching, findAgents, choose, forget, error };
}
