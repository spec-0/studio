import type { ReactNode } from "react";
import { TabList } from "./TabList";
import { SettingsSection } from "./settings/SettingsSection";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "../lib/navigation";

interface Props {
  section: SettingsSectionId;
  onSection: (section: SettingsSectionId) => void;
  /** The content of each section. Kept by the caller, which holds the state. */
  content: Record<SettingsSectionId, ReactNode>;
}

const DESCRIPTIONS: Record<SettingsSectionId, string> = {
  account: "Signing in, signing out, and what connecting to Spec0 adds.",
  network: "How requests reach your servers: certificates, proxy, timeout, redirects and cookies.",
  updates: "Updates to Studio itself. Nothing is checked unless you ask.",
  appearance: "How Studio looks.",
  mcp: "Let a coding agent on this machine see the APIs open in Studio.",
  data: "What Studio keeps, where it keeps it, and how to clear it.",
};

/** The Settings page: a list of sections on the left, the chosen one on the right. */
export function SettingsView({ section, onSection, content }: Props) {
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
          tabs={SETTINGS_SECTIONS}
          selected={current.id}
          onSelect={onSection}
        />
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
