import { useEffect, useMemo, useRef, useState } from "react";
import { sourceLabel, type LibraryEntry } from "../lib/library";
import { FileText, Plus, Search } from "lucide-react";
import { plural } from "../lib/plural";
import { shortcut } from "../lib/platform";

interface Props {
  entries: LibraryEntry[];
  currentId: string | null;
  onPick: (entry: LibraryEntry) => void;
  onGoLibrary: () => void;
  onAddApi: () => void;
  onClose: () => void;
}

/** ⌘P / Ctrl+P: jump between the APIs in the library without going home first. */
export function ApiSwitcher({ entries, currentId, onPick, onGoLibrary, onAddApi, onClose }: Props) {
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
      <div className="palette" role="dialog" aria-modal="true" aria-label="Switch API" onClick={(event) => event.stopPropagation()}>
        <div className="palette-query">
          <Search size={15} aria-hidden />
          <input
            ref={input}
            value={filter}
            placeholder="Switch to an API…"
            aria-label="Find an API"
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
          <span className="kbd">esc</span>
        </div>

        <div className="palette-list" role="listbox" aria-label="APIs">
          <div className="palette-group">APIs</div>
          {shown.map((entry, index) => (
            <button
              key={entry.id}
              className="palette-row"
              role="option"
              aria-selected={index === cursor}
              onMouseEnter={() => setCursor(index)}
              onClick={() => onPick(entry)}
              title={sourceLabel(entry.source)}
            >
              <FileText size={14} aria-hidden className="palette-icon" />
              <span className="palette-title">{entry.title}</span>
              <span className="meta">{plural(entry.operations, "operation")}</span>
              <span className="spacer" />
              {entry.update && (
                <span className="chip sans warn" title="A newer version is available">
                  Update
                </span>
              )}
              {entry.version && <span className="chip">{entry.version}</span>}
              {entry.id === currentId && <span className="meta">current</span>}
            </button>
          ))}
          {shown.length === 0 && <div className="palette-none">No matching API</div>}
        </div>

        <div className="palette-foot">
          <span className="meta">
            <span className="kbd">↑↓</span> move <span className="kbd">↵</span> open <span className="kbd">esc</span> close
          </span>
          <span className="spacer" />
          <button className="btn ghost sm" onClick={onAddApi}>
            <Plus size={12} /> Add API… <span className="kbd">{shortcut("O")}</span>
          </button>
          <button className="btn ghost sm" onClick={onGoLibrary}>
            All APIs <span className="kbd">{shortcut("L")}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
