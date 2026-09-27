import { useRef, type ReactNode } from "react";
import { nextTab } from "../lib/navigation";

export interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
  /** Tooltip, e.g. with the keyboard shortcut. */
  title?: string;
}

interface Props<T extends string> {
  tabs: ReadonlyArray<TabItem<T>>;
  /** The selected tab, or null when none is (Settings has no top-bar tab). */
  selected: T | null;
  onSelect: (id: T) => void;
  /** What the list is, for screen readers. */
  label: string;
  className: string;
  tabClassName: string;
  orientation?: "horizontal" | "vertical";
  /** Prefix for element ids, so a tab can name the panel it controls. */
  idPrefix?: string;
  /** The id of the panel the tabs control, if there is one on screen. */
  controls?: string;
}

/**
 * A row (or column) of tabs following the WAI-ARIA tabs pattern: one tab stop,
 * arrow keys to move between tabs, Home and End for the ends. Moving selects
 * the tab too, since every tab here is cheap to show.
 */
export function TabList<T extends string>({
  tabs,
  selected,
  onSelect,
  label,
  className,
  tabClassName,
  orientation = "horizontal",
  idPrefix,
  controls,
}: Props<T>) {
  const list = useRef<HTMLDivElement>(null);
  const ids = tabs.map((tab) => tab.id);
  const focusable = selected && ids.includes(selected) ? selected : ids[0];

  return (
    <div
      ref={list}
      className={className}
      role="tablist"
      aria-label={label}
      aria-orientation={orientation}
      onKeyDown={(event) => {
        const next = nextTab(ids, focusable, event.key, orientation);
        if (next === null) return;
        event.preventDefault();
        onSelect(next);
        list.current?.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus();
      }}
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          id={idPrefix ? `${idPrefix}-${tab.id}` : undefined}
          data-tab={tab.id}
          className={tabClassName}
          role="tab"
          type="button"
          aria-selected={selected === tab.id}
          aria-controls={selected === tab.id ? controls : undefined}
          tabIndex={tab.id === focusable ? 0 : -1}
          title={tab.title}
          onClick={() => onSelect(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
