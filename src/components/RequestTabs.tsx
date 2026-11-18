import { useEffect, useRef } from "react";
import { Plus, X } from "lucide-react";
import type { LibraryEntry } from "../lib/library";
import { isMac, shortcut } from "../lib/platform";
import type { RequestTab } from "../lib/tabs";

interface Props {
  tabs: RequestTab[];
  activeKey: string | null;
  /** For each tab's current API title; a tab keeps the one it was opened with if its API is gone. */
  entries: LibraryEntry[];
  hasUnsent: (key: string) => boolean;
  onActivate: (tab: RequestTab) => void;
  onClose: (key: string) => void;
  /** "+": a new request, in the scratch pad. */
  onNew: () => void;
}

const NEXT = isMac ? "⌃Tab or ⇧⌘]" : "Ctrl+Tab";
const CLOSE = shortcut("W");

/** DELETE is the one method that crowds a tab; the full name is in the tooltip. */
const short = (method: string) => (method === "DELETE" ? "DEL" : method);

/** An API's name, shortened to its first word for a tab. */
const firstWord = (title: string) => title.split(/\s+/)[0] ?? title;

/**
 * The open requests, across APIs, above the API bar: like a browser's tabs,
 * and the bar below describes the active tab's API. Click to switch, the ×
 * or a middle-click to close. Closing never loses unsent changes; they stay
 * with the operation, marked in the sidebar.
 */
export function RequestTabs({ tabs, activeKey, entries, hasUnsent, onActivate, onClose, onNew }: Props) {
  const strip = useRef<HTMLDivElement>(null);

  // Keep the active tab in view when it's chosen from somewhere else.
  useEffect(() => {
    const active = strip.current?.querySelector<HTMLElement>('[aria-current="page"]');
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeKey, tabs.length]);

  if (!tabs.length) return null;
  const titles = new Map(entries.map((entry) => [entry.id, entry.title]));
  // The API's name only earns its space once the tabs span more than one API.
  const manyApis = new Set(tabs.map((tab) => tab.apiId)).size > 1;

  return (
    <nav className="request-tabs" aria-label="Open requests">
      <div className="request-tabs-strip" ref={strip}>
        {tabs.map((tab) => {
          const apiTitle = titles.get(tab.apiId) ?? tab.apiTitle;
          const unsent = hasUnsent(tab.key);
          const active = tab.key === activeKey;
          const method = tab.method.toUpperCase();
          return (
            <div
              key={tab.key}
              className={`request-tab${active ? " active" : ""}`}
              onMouseDown={(event) => {
                // Middle-click closes; stop the browser's autoscroll from starting.
                if (event.button === 1) event.preventDefault();
              }}
              onAuxClick={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  onClose(tab.key);
                }
              }}
            >
              <button
                type="button"
                className="request-tab-open"
                aria-current={active ? "page" : undefined}
                title={`${method} ${tab.path} · ${apiTitle}${unsent ? " · unsent changes" : ""}\n${NEXT} for the next tab`}
                onClick={() => onActivate(tab)}
              >
                <span className={`method ${method.toLowerCase()}`}>{short(method)}</span>
                <span className="request-tab-path">{tab.path}</span>
                {manyApis && <span className="request-tab-api">{firstWord(apiTitle)}</span>}
                {unsent && (
                  <span className="dirty-dot" role="img" aria-label="Unsent changes" />
                )}
              </button>
              <button
                type="button"
                className="request-tab-close"
                aria-label={`Close ${method} ${tab.path}`}
                title={active ? `Close tab (${CLOSE})` : "Close tab"}
                onClick={() => onClose(tab.key)}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
      <button type="button" className="request-tabs-new" onClick={onNew} title="New request, without a spec (Scratch)" aria-label="New request">
        <Plus size={14} aria-hidden />
      </button>
    </nav>
  );
}
