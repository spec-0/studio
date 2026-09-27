import { Layers, Plus, Settings } from "lucide-react";
import { Brand } from "./Logo";
import { ConnectionChip } from "./ConnectionChip";
import { TabList } from "./TabList";
import type { EnvironmentFile } from "../lib/env";
import { TOP_TABS, type TopTab } from "../lib/navigation";
import { shortcut } from "../lib/platform";
import type { Session } from "../lib/spec0";

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
  /** The status chip: opens Settings at Account & Spec0. */
  onOpenAccount: () => void;
  settingsOpen: boolean;
  onOpenSettings: () => void;
}

const TAB_TITLES: Record<TopTab, string> = {
  apis: `Your APIs (${shortcut("L")} for the list)`,
  history: "Every request, across all APIs",
  mocks: "Hosted mock servers",
  mcp: "A local MCP server for your coding agent",
};

/**
 * The window's top bar: the app's sections as text tabs on the left; the
 * environment, whether you're signed in, and Settings on the right. What's
 * specific to the open API is in the bar below it (`ApiBar`).
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
  settingsOpen,
  onOpenSettings,
}: Props) {
  return (
    <div className="titlebar" data-tauri-drag-region>
      <Brand compact />

      <TabList
        className="nav-tabs"
        tabClassName="nav-tab"
        label="Sections"
        tabs={TOP_TABS.map((tab) => ({ ...tab, title: TAB_TITLES[tab.id] }))}
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

      <ConnectionChip session={session} onClick={onOpenAccount} />

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
