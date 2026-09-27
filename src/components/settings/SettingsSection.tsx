import type { ReactNode } from "react";
import type { SettingsSectionId } from "../../lib/navigation";

interface Props {
  id: SettingsSectionId;
  title: string;
  /** One line under the title saying what the section is for. */
  description?: ReactNode;
  children: ReactNode;
}

/** One section of the Settings page: the panel its tab in the section list controls. */
export function SettingsSection({ id, title, description, children }: Props) {
  return (
    <section
      className="settings-section"
      id={`settings-panel-${id}`}
      role="tabpanel"
      aria-labelledby={`settings-tab-${id}`}
      data-section={id}
    >
      <header className="settings-head">
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </header>
      {children}
    </section>
  );
}
