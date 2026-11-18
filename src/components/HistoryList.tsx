import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, ListOrdered } from "lucide-react";
import { historyRows } from "../lib/collectionRun";
import { relativeTime, type HistoryEntry } from "../lib/history";
import { plural } from "../lib/plural";

interface Props {
  entries: HistoryEntry[];
  selectedId: string | null;
  onOpen: (entry: HistoryEntry) => void;
  /** Show which API each row came from, for the list that covers all of them. */
  showApi?: boolean;
}

/**
 * Rows of recorded requests. Clicking one opens it read-only; nothing here
 * loads it into an editor. A collection run is one row that opens to show its
 * steps.
 */
export function HistoryList({ entries, selectedId, onOpen, showApi = false }: Props) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  let lastDay = "";
  return (
    <>
      {historyRows(entries).map((row) => {
        const at = row.kind === "entry" ? row.entry.at : row.at;
        const day = dayLabel(at);
        const heading = day !== lastDay ? <div className="list-group history-day" key={`day-${day}-${at}`}>{day}</div> : null;
        lastDay = day;
        return (
          <HistoryRowGroup key={row.kind === "entry" ? row.entry.id : row.runId} heading={heading}>
            {renderRow(row)}
          </HistoryRowGroup>
        );
      })}
    </>
  );

  function renderRow(row: ReturnType<typeof historyRows>[number]) {
        if (row.kind === "entry") {
          return <EntryRow key={row.entry.id} entry={row.entry} selectedId={selectedId} onOpen={onOpen} showApi={showApi} />;
        }
        const expanded = open.has(row.runId) || row.entries.some((e) => e.id === selectedId);
        return (
          <div key={row.runId} className="history-run">
            <button
              type="button"
              className="row history-row run-row"
              aria-expanded={expanded}
              onClick={() =>
                setOpen((prev) => {
                  const next = new Set(prev);
                  if (next.has(row.runId)) next.delete(row.runId);
                  else next.add(row.runId);
                  return next;
                })
              }
              title={`Collection run: ${row.name}`}
            >
              {expanded ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
              <ListOrdered size={13} aria-hidden className="run-icon" />
              <span style={{ minWidth: 0, display: "grid", flex: 1 }}>
                <span className="history-run-name">{row.name}</span>
                <span className="summary">
                  Collection run · {row.passed} of {row.entries.length} passed
                  {row.failed ? ` · ${row.failed} failed` : ""}
                </span>
              </span>
              <span className="history-right">
                <span className={`run-dot ${row.failed ? "fail" : "pass"}`} aria-hidden />
                <span className="mono history-time">{clock(row.at)}</span>
              </span>
            </button>
            {expanded &&
              row.entries.map((entry) => (
                <EntryRow key={entry.id} entry={entry} selectedId={selectedId} onOpen={onOpen} showApi={showApi} nested />
              ))}
          </div>
        );
  }
}

function HistoryRowGroup({ heading, children }: { heading: ReactNode; children: ReactNode }) {
  return (
    <>
      {heading}
      {children}
    </>
  );
}

/** "Today", "Yesterday", or the date. */
function dayLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Earlier";
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

/** "21:44". */
function clock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function EntryRow({
  entry,
  selectedId,
  onOpen,
  showApi,
  nested = false,
}: {
  entry: HistoryEntry;
  selectedId: string | null;
  onOpen: (entry: HistoryEntry) => void;
  showApi: boolean;
  nested?: boolean;
}) {
  return (
    <button
      className={`row history-row${nested ? " nested" : ""}`}
      aria-selected={selectedId === entry.id}
      onClick={() => onOpen(entry)}
      title={`${entry.url}\n${entry.status} · ${entry.ms}ms`}
    >
      <span className={`method ${entry.method.toLowerCase()}`}>{entry.method === "DELETE" ? "DEL" : entry.method}</span>
      <span style={{ minWidth: 0, display: "grid", flex: 1 }}>
        <span className="path">{entry.path}</span>
        <span className="summary">
          {nested && entry.collection ? `${entry.collection.index + 1}. ${entry.collection.step} · ` : ""}
          {showApi && <>{entry.specTitle} · </>}
          {targetWords(entry)}
          {entry.validation === "mismatch" && (
            <span className="warn-ink">
              {" · "}
              {entry.findings?.length ? plural(entry.findings.length, "difference") : "differs from the spec"}
            </span>
          )}
        </span>
      </span>
      <span className="history-right">
        <span className={`mono status-ink s${Math.floor(entry.status / 100)}`}>{entry.status}</span>
        <span className="mono history-time" title={relativeTime(entry.at)}>
          {clock(entry.at)}
        </span>
      </span>
    </button>
  );
}

/** Where a request went, in a word or two: "local mock", "hosted mock", a host, or "typed URL". */
function targetWords(entry: HistoryEntry): string {
  if (entry.target) {
    if (entry.target.kind === "local-mock") return "local mock";
    if (entry.target.kind === "mock") return "hosted mock";
    if (entry.target.kind === "custom") return "typed URL";
    return entry.target.label;
  }
  if (entry.mock) return "mock";
  try {
    return new URL(entry.url).host;
  } catch {
    return "";
  }
}
