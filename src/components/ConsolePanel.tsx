import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, Trash2, X } from "lucide-react";
import {
  CONSOLE_FILTERS,
  MAX_CONSOLE_ENTRIES,
  clearConsole,
  entriesText,
  filterEntries,
  setConsoleOpen,
  type ConsoleEntry,
  type ConsoleFilter,
} from "../lib/appConsole";
import { isMac } from "../lib/platform";
import { consoleShortcutLabel } from "../lib/shortcuts";
import { useAppConsole } from "../hooks/useAppConsole";
import { TabList } from "./TabList";

interface Props {
  /** Open a collection run's log. */
  onOpenRun: (collectionId: string, runId: string) => void;
}

const SOURCE_LABEL: Record<ConsoleEntry["source"], string> = {
  request: "request",
  collection: "collection",
  mock: "local mock",
  mcp: "MCP",
  agent: "agent chat",
};

function time(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/**
 * The app console: this session's requests, collection runs, local mock
 * requests and MCP calls, newest at the bottom. In memory only.
 */
export function ConsolePanel({ onOpenRun }: Props) {
  const { entries, open, dropped } = useAppConsole();
  const [filter, setFilter] = useState<ConsoleFilter>("all");
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState(false);
  const list = useRef<HTMLOListElement>(null);
  const shown = useMemo(() => filterEntries(entries, filter, query), [entries, filter, query]);
  const counts = useMemo(
    () => Object.fromEntries(CONSOLE_FILTERS.map((f) => [f.id, filterEntries(entries, f.id).length])),
    [entries],
  );

  // Follow new entries while the list is scrolled to the bottom.
  const pinned = useRef(true);
  useEffect(() => {
    const el = list.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [shown.length, open]);

  if (!open) return null;

  return (
    <section className="console" aria-label="Console">
      <header className="console-head">
        <strong className="console-title">Console</strong>
        <TabList<ConsoleFilter>
          className="segmented sm console-filters"
          tabClassName="segment"
          label="Show"
          tabs={CONSOLE_FILTERS.map((f) => ({
            id: f.id,
            label: (
              <>
                {f.label}
                {counts[f.id] ? <span className={f.id === "errors" ? "console-count" : "c"}>{counts[f.id]}</span> : null}
              </>
            ),
          }))}
          selected={filter}
          onSelect={setFilter}
        />
        <input
          className="console-search"
          type="search"
          placeholder="Filter"
          aria-label="Filter console entries"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <span className="spacer" />
        <button
          type="button"
          className="btn ghost tight"
          disabled={!shown.length}
          onClick={() => {
            void navigator.clipboard?.writeText(entriesText(shown)).catch(() => {});
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2500);
          }}
        >
          <Copy size={12} aria-hidden /> {copied ? "Copied" : "Copy"}
        </button>
        <button type="button" className="btn ghost tight" disabled={!entries.length} onClick={clearConsole}>
          <Trash2 size={12} aria-hidden /> Clear
        </button>
        <button
          type="button"
          className="icon-btn tight"
          aria-label="Close the console"
          title={`Close (${consoleShortcutLabel(isMac)})`}
          onClick={() => setConsoleOpen(false)}
        >
          <X size={13} />
        </button>
      </header>
      <ol
        ref={list}
        className="console-list"
        onScroll={(event) => {
          const el = event.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {shown.map((entry) => (
          <li key={entry.id} className={`console-entry ${entry.level}`}>
            <span className="console-time">{time(entry.at)}</span>
            <span className={`console-source ${entry.source}`}>{SOURCE_LABEL[entry.source]}</span>
            <span className="console-text">
              {entry.text}
              {entry.notes?.map((line) => (
                <span key={line} className="console-note">
                  {line}
                </span>
              ))}
            </span>
            {entry.run && (
              <button
                type="button"
                className="btn ghost tight console-open"
                onClick={() => onOpenRun(entry.run!.collectionId, entry.run!.runId)}
              >
                Open log
              </button>
            )}
          </li>
        ))}
        {!shown.length && (
          <li className="console-empty">
            {entries.length
              ? "Nothing matches this filter."
              : "Nothing yet. Requests, collection runs, local mock requests and MCP calls show here as they happen."}
          </li>
        )}
      </ol>
      <footer className="console-foot field-meta">
        This session only: kept in memory, never saved or sent anywhere. The last {MAX_CONSOLE_ENTRIES} entries are
        kept{dropped ? ` (${dropped} older one${dropped === 1 ? "" : "s"} dropped)` : ""}. Secret values are replaced by
        their names; MCP calls show the tool's name only.
      </footer>
    </section>
  );
}
