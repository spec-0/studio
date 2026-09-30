import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import type { LibraryEntry } from "../../lib/library";
import type { OperationSpec, ParsedSpec } from "../../lib/spec";

interface Props {
  entries: LibraryEntry[];
  /** The API to start in: the step's own, when it's in the library. */
  initialEntryId: string | null;
  /** What the step points at now, to help find its replacement. */
  hint: string;
  loadSpec: (entry: LibraryEntry) => Promise<ParsedSpec | null>;
  onPick: (entry: LibraryEntry, op: OperationSpec) => void;
  onClose: () => void;
  /** "Change operation" for a linked step, "Link to an operation" for one that isn't. */
  title?: string;
}

/**
 * "Change operation…" (or "Link to an operation…" for a step that isn't
 * linked): choose an API from the library, then one of its operations. The
 * step keeps its inputs.
 */
export function LinkOperationDialog({ entries, initialEntryId, hint, loadSpec, onPick, onClose, title = "Link to an operation" }: Props) {
  const [entryId, setEntryId] = useState(initialEntryId ?? entries[0]?.id ?? "");
  const [spec, setSpec] = useState<ParsedSpec | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const entry = entries.find((e) => e.id === entryId) ?? null;

  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    if (!entry) return;
    let live = true;
    setLoading(true);
    void loadSpec(entry).then((next) => {
      if (!live) return;
      setSpec(next);
      setLoading(false);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryId]);

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const ops = spec?.operations ?? [];
    return needle
      ? ops.filter((op) => `${op.method} ${op.path} ${op.operationId ?? ""} ${op.summary ?? ""}`.toLowerCase().includes(needle))
      : ops;
  }, [spec, filter]);
  useEffect(() => setCursor(0), [filter, spec]);

  return (
    <div className="scrim top" onClick={onClose}>
      <div
        className="palette link-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="link-head">
          <strong>{title}</strong>
          <span className="meta">was {hint}</span>
          <span className="spacer" />
          <button type="button" className="icon-btn tight" aria-label="Close" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <div className="link-bar">
          <select aria-label="API" value={entryId} onChange={(event) => setEntryId(event.target.value)}>
            {entries.map((e) => (
              <option key={e.id} value={e.id}>
                {e.title}
              </option>
            ))}
          </select>
        </div>
        <input
          ref={input}
          value={filter}
          placeholder="Find an operation…"
          aria-label="Find an operation"
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setCursor((c) => Math.min(c + 1, shown.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            } else if (event.key === "Enter" && entry && shown[cursor]) {
              event.preventDefault();
              onPick(entry, shown[cursor]);
            }
          }}
        />
        <div className="palette-list" role="listbox" aria-label="Operations">
          {loading && <div className="group-label">Reading {entry?.title}…</div>}
          {!loading && !entries.length && <div className="group-label">Your library is empty. Add an API first.</div>}
          {!loading && entries.length > 0 && !shown.length && <div className="group-label">No matching operations</div>}
          {!loading &&
            entry &&
            shown.map((op, index) => (
              <button
                key={op.id}
                type="button"
                role="option"
                className="row"
                aria-selected={index === cursor}
                onMouseEnter={() => setCursor(index)}
                onClick={() => onPick(entry, op)}
              >
                <span className={`method ${op.method.toLowerCase()}`}>{op.method}</span>
                <span style={{ minWidth: 0, display: "grid", flex: 1 }}>
                  <span className="path">{op.path}</span>
                  <span className="summary">{op.summary ?? op.operationId ?? ""}</span>
                </span>
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}
