import { useState } from "react";
import { ChevronDown, ChevronRight, ListOrdered } from "lucide-react";
import { historyRows } from "../lib/collectionRun";
import { relativeTime, type HistoryEntry } from "../lib/history";

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
  return (
    <>
      {historyRows(entries).map((row) => {
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
                <span className="path">{row.name}</span>
                <span className="summary">
                  {row.entries.length} step{row.entries.length === 1 ? "" : "s"} · {row.passed} passed
                  {row.failed ? ` · ${row.failed} failed` : ""} · {relativeTime(row.at)}
                </span>
              </span>
              <span className={`run-dot ${row.failed ? "fail" : "pass"}`} aria-hidden />
            </button>
            {expanded &&
              row.entries.map((entry) => (
                <EntryRow key={entry.id} entry={entry} selectedId={selectedId} onOpen={onOpen} showApi={showApi} nested />
              ))}
          </div>
        );
      })}
    </>
  );
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
      <span className={`method ${entry.method.toLowerCase()}`}>{entry.method}</span>
      <span style={{ minWidth: 0, display: "grid", flex: 1 }}>
        <span className="path">{entry.path}</span>
        <span className="summary">
          {nested && entry.collection ? `${entry.collection.index + 1}. ${entry.collection.step} · ` : ""}
          {showApi && <>{entry.specTitle} · </>}
          {entry.status} · {entry.ms}ms · {relativeTime(entry.at)}
          {entry.mock ? " · mock" : ""}
        </span>
      </span>
      {entry.validation === "mismatch" && (
        <span className="count" style={{ color: "hsl(var(--warning))" }}>
          drift
        </span>
      )}
    </button>
  );
}
