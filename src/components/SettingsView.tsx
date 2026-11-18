import type { ReactNode } from "react";
import { ArrowUpRight, BotMessageSquare, Database, Globe, Palette, RefreshCw, UserRound, type LucideIcon } from "lucide-react";
import { TabList } from "./TabList";
import { SettingsSection } from "./settings/SettingsSection";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "../lib/navigation";

interface Props {
  section: SettingsSectionId;
  onSection: (section: SettingsSectionId) => void;
  /** The content of each section. Kept by the caller, which holds the state. */
  content: Record<SettingsSectionId, ReactNode>;
  /** The MCP server's settings are on its own page. */
  onOpenMcp: () => void;
}

const DESCRIPTIONS: Record<SettingsSectionId, string> = {
  account: "Signing in, signing out, and what connecting to Spec0 adds.",
  network: "How requests reach your servers: certificates, proxy, timeout, redirects and cookies.",
  updates: "Updates to Studio itself. Nothing is checked unless you ask.",
  appearance: "How Studio looks.",
  agent: "Chat with a coding agent you already use, inside Studio.",
  data: "What Studio keeps, where it keeps it, and how to clear it.",
};

const ICONS: Record<SettingsSectionId, LucideIcon> = {
  account: UserRound,
  appearance: Palette,
  network: Globe,
  agent: BotMessageSquare,
  data: Database,
  updates: RefreshCw,
};

/** The Settings page: a list of sections on the left, the chosen one on the right. */
export function SettingsView({ section, onSection, content, onOpenMcp }: Props) {
  const current = SETTINGS_SECTIONS.find((entry) => entry.id === section) ?? SETTINGS_SECTIONS[0];
  return (
    <div className="panes settings">
      <aside className="settings-nav">
        <h2>Settings</h2>
        <TabList
          className="settings-tabs"
          tabClassName="settings-tab"
          label="Settings sections"
          orientation="vertical"
          idPrefix="settings-tab"
          controls={`settings-panel-${current.id}`}
          tabs={SETTINGS_SECTIONS.map((entry) => {
            const Icon = ICONS[entry.id];
            return {
              id: entry.id,
              label: (
                <>
                  <Icon size={14} aria-hidden /> {entry.label}
                </>
              ),
            };
          })}
          selected={current.id}
          onSelect={onSection}
        />
        <div className="settings-elsewhere">
          <span className="label">Elsewhere</span>
          <button type="button" className="settings-tab" onClick={onOpenMcp}>
            <ArrowUpRight size={14} aria-hidden /> MCP server
          </button>
        </div>
      </aside>
      <div className="settings-main">
        <SettingsSection
          key={current.id}
          id={current.id}
          title={current.label}
          description={DESCRIPTIONS[current.id]}
        >
          {content[current.id]}
        </SettingsSection>
      </div>
    </div>
  );
}
