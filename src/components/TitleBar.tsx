import { BotMessageSquare, Layers, Plus, Settings } from "lucide-react";
import { Brand } from "./Logo";
import { ConnectionChip } from "./ConnectionChip";
import { TabList } from "./TabList";
import type { EnvironmentFile } from "../lib/env";
import { TOP_TABS, type TopTab } from "../lib/navigation";
import { isMac, shortcut } from "../lib/platform";
import type { Session } from "../lib/spec0";
import { agentButtonText, agentChatShortcutLabel, toggleAgentChatPanel } from "../lib/agentChatPanel";
import { useAgentChatActivity, useAgentChatPanelOpen } from "../hooks/useAgentChatPanelOpen";

interface Props {
  /** The selected tab, or null on the Settings page. */
  topTab: TopTab | null;
  onTopTab: (tab: TopTab) => void;
  session: Session | null;
  /** Certificate verification is off for at least one host. */
  insecureHosts: boolean;
  envFile: EnvironmentFile;
  onSelectEnvironment: (id: string | null) => void;
  onEditEnvironments: () => void;
  /** The avatar: opens Settings at Account & Spec0. */
  onOpenAccount: () => void;
  /** "Sign in", when signed out. */
  onSignIn: () => void;
  settingsOpen: boolean;
  onOpenSettings: () => void;
  /** How many local mocks are running, for a dot on the Mocks tab. */
  localMocks?: number;
}

const TAB_TITLES: Record<TopTab, string> = {
  apis: `Your APIs (${shortcut("L")} for the list)`,
  collections: "Steps across your specs, run in order",
  history: "Every request, across all APIs",
  mocks: "Mock servers: on this computer and hosted",
  mcp: "A local MCP server for your coding agent",
};

/**
 * The window's top bar: the app's sections as text tabs on the left; the
 * environment, whether you're signed in, the agent chat and Settings on the
 * right. What's specific to the open API is in the bar below it (`ApiBar`).
 */
export function TitleBar({
  topTab,
  onTopTab,
  session,
  insecureHosts,
  envFile,
  onSelectEnvironment,
  onEditEnvironments,
  onOpenAccount,
  onSignIn,
  settingsOpen,
  onOpenSettings,
  localMocks = 0,
}: Props) {
  return (
    <div className="titlebar" data-tauri-drag-region>
      <Brand compact />

      <TabList
        className="nav-tabs"
        tabClassName="nav-tab"
        label="Sections"
        tabs={TOP_TABS.map((tab) =>
          tab.id === "mocks" && localMocks > 0
            ? {
                ...tab,
                label: (
                  <>
                    {tab.label}
                    <span className="dot live" aria-hidden />
                    <span className="sr-only"> ({localMocks} running on this computer)</span>
                  </>
                ),
                title: `${TAB_TITLES.mocks} · ${localMocks} running on this computer`,
              }
            : { ...tab, title: TAB_TITLES[tab.id] },
        )}
        selected={topTab}
        onSelect={onTopTab}
      />

      <span className="spacer" data-tauri-drag-region />

      <div className="env-picker" title={`Environment (${shortcut("E")} to edit)`}>
        <Layers size={13} aria-hidden />
        <select
          aria-label="Environment"
          value={envFile.activeId ?? ""}
          onChange={(event) => onSelectEnvironment(event.target.value || null)}
        >
          <option value="">No environment</option>
          {envFile.environments.map((env) => (
            <option key={env.id} value={env.id}>
              {env.name}
            </option>
          ))}
        </select>
        <button
          className="icon-btn tight"
          onClick={onEditEnvironments}
          aria-label="Edit environments"
          title={`Edit environments (${shortcut("E")})`}
        >
          <Plus size={13} />
        </button>
      </div>

      <AgentButton />

      <ConnectionChip session={session} onOpenAccount={onOpenAccount} onSignIn={onSignIn} />

      <button
        className={`icon-btn settings-btn${settingsOpen ? " on" : ""}${insecureHosts ? " warn-dot" : ""}`}
        onClick={onOpenSettings}
        aria-label={
          insecureHosts
            ? "Settings (certificate checks are off for at least one host)"
            : "Settings"
        }
        aria-pressed={settingsOpen}
        title={
          insecureHosts
            ? `Settings (${shortcut(",")}). Certificate checks are off for at least one host.`
            : `Settings (${shortcut(",")})`
        }
      >
        <Settings size={16} />
      </button>
    </div>
  );
}

/**
 * Opens and closes the agent chat. Labelled, rather than an icon alone, so it's
 * easy to find; a dot shows a running chat, and turns amber while the agent
 * waits for an answer, even with the panel closed.
 */
function AgentButton() {
  const open = useAgentChatPanelOpen();
  const activity = useAgentChatActivity();
  const { label, title } = agentButtonText(open, activity, isMac);
  return (
    <button
      type="button"
      className={`agent-btn${open ? " on" : ""}`}
      onClick={toggleAgentChatPanel}
      aria-pressed={open}
      aria-label={label}
      title={title}
    >
      <BotMessageSquare size={14} aria-hidden />
      <span>Agent</span>
      <span className="kbd">{agentChatShortcutLabel(isMac)}</span>
      {activity !== "idle" && <span className={`agent-btn-dot ${activity}`} aria-hidden />}
    </button>
  );
}
