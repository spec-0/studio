import { useEffect, useMemo, useRef, useState } from "react";
import { sourceLabel, type LibraryEntry } from "../lib/library";

interface Props {
  entries: LibraryEntry[];
  currentId: string | null;
  onPick: (entry: LibraryEntry) => void;
  onGoLibrary: () => void;
  onClose: () => void;
}

/** ⌘P / Ctrl+P — jump between the APIs in the library without going home first. */
export function ApiSwitcher({ entries, currentId, onPick, onGoLibrary, onClose }: Props) {
  const [filter, setFilter] = useState("");
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const rows = needle
      ? entries.filter((entry) =>
          `${entry.title} ${sourceLabel(entry.source)}`.toLowerCase().includes(needle),
        )
      : entries;
    return rows.slice(0, 12);
  }, [entries, filter]);

  useEffect(() => setCursor(0), [filter]);

  return (
    <div className="scrim top" onClick={onClose}>
      <div className="palette" onClick={(event) => event.stopPropagation()}>
        <input
          ref={input}
          value={filter}
          placeholder="Switch to an API…"
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setCursor((c) => Math.min(c + 1, shown.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              if (shown[cursor]) onPick(shown[cursor]);
            }
          }}
        />

        <div className="palette-list">
          {shown.map((entry, index) => (
            <button
              key={entry.id}
              className="row"
              aria-selected={index === cursor}
              onMouseEnter={() => setCursor(index)}
              onClick={() => onPick(entry)}
            >
              <span style={{ minWidth: 0, display: "grid", flex: 1 }}>
                <span className="path">
                  {entry.title}
                  {entry.id === currentId && <span className="meta"> · current</span>}
                </span>
                <span className="summary">
                  {entry.operations} operations · {sourceLabel(entry.source)}
                </span>
              </span>
              {entry.update && (
                <span className="tag update" title="A newer version is available">
                  update
                </span>
              )}
              <span className={`tag src-${entry.source.kind}`}>{entry.source.kind}</span>
            </button>
          ))}
          {shown.length === 0 && <div className="group-label">No matching API</div>}
        </div>

        <div className="palette-foot">
          <button className="btn" onClick={onGoLibrary}>
            All APIs
          </button>
          <span className="spacer" />
          <span className="meta">↑↓ move · ↵ open · esc close</span>
        </div>
      </div>
    </div>
  );
}
