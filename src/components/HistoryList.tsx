import { relativeTime, type HistoryEntry } from "../lib/history";

interface Props {
  entries: HistoryEntry[];
  selectedId: string | null;
  onOpen: (entry: HistoryEntry) => void;
  /** Show which API each row came from — for the list that covers all of them. */
  showApi?: boolean;
}

/**
 * Rows of recorded requests. Clicking one opens it read-only; nothing here
 * loads it into an editor.
 */
export function HistoryList({ entries, selectedId, onOpen, showApi = false }: Props) {
  return (
    <>
      {entries.map((entry) => (
        <button
          key={entry.id}
          className="row history-row"
          aria-selected={selectedId === entry.id}
          onClick={() => onOpen(entry)}
          title={`${entry.url}\n${entry.status} · ${entry.ms}ms`}
        >
          <span className={`method ${entry.method.toLowerCase()}`}>{entry.method}</span>
          <span style={{ minWidth: 0, display: "grid", flex: 1 }}>
            <span className="path">{entry.path}</span>
            <span className="summary">
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
      ))}
    </>
  );
}
