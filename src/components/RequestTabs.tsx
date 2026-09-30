import { useEffect, useRef } from "react";
import { X } from "lucide-react";
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
}

const NEXT = isMac ? "⌃Tab or ⇧⌘]" : "Ctrl+Tab";
const CLOSE = shortcut("W");

/**
 * The open requests, across APIs, under the API bar. Click to switch, the ×
 * or a middle-click to close. Closing never loses unsent changes; they stay
 * with the operation, marked in the sidebar.
 */
export function RequestTabs({ tabs, activeKey, entries, hasUnsent, onActivate, onClose }: Props) {
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
                <span className={`method ${method.toLowerCase()}`}>{method}</span>
                <span className="request-tab-path">{tab.path}</span>
                {manyApis && <span className="request-tab-api">{apiTitle}</span>}
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
    </nav>
  );
}
