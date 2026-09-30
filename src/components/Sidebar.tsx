import { useMemo } from "react";
import type { OperationSpec, ParsedSpec, SchemaEntry } from "../lib/spec";
import { search as searchHistory, type HistoryEntry } from "../lib/history";
import { HistoryList } from "./HistoryList";
import { TabList } from "./TabList";

export type SidebarTab = "operations" | "schemas" | "history";

interface Props {
  spec: ParsedSpec;
  /**
   * What the sidebar lists. The Operations and Schemas tabs above choose
   * between operations and schemas; under Operations, the sidebar's own tabs
   * switch between the operations and this API's history.
   */
  tab: SidebarTab;
  onTabChange: (tab: SidebarTab) => void;
  query: string;
  onQueryChange: (query: string) => void;
  selectedOperation: string | null;
  onSelectOperation: (op: OperationSpec) => void;
  selectedSchema: string | null;
  onSelectSchema: (name: string) => void;
  /** This API's recorded requests only — the full log is its own view. */
  history: HistoryEntry[];
  /** The recorded request open in the work area, if any. */
  selectedRecord: string | null;
  /** Open a recorded request, read-only. */
  onOpenRecord: (entry: HistoryEntry) => void;
  /** Go to the one list across every API. */
  onOpenAllHistory: () => void;
  /** Right-click (or Shift+F10) on an operation: its menu, at that position. */
  onOperationMenu?: (op: OperationSpec, position: { x: number; y: number }) => void;
}

/** Loose subsequence match — "gtusr" finds "GET /users". */
function fuzzy(haystack: string, needle: string): boolean {
  if (!needle) return true;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  if (h.includes(n)) return true;
  let i = 0;
  for (const char of h) {
    if (char === n[i]) i += 1;
    if (i === n.length) return true;
  }
  return false;
}

export function Sidebar({
  spec,
  tab,
  onTabChange,
  query,
  onQueryChange,
  selectedOperation,
  onSelectOperation,
  selectedSchema,
  onSelectSchema,
  history,
  selectedRecord,
  onOpenRecord,
  onOpenAllHistory,
  onOperationMenu,
}: Props) {
  const groupedOperations = useMemo(() => {
    const matches = spec.operations.filter((op) =>
      fuzzy(`${op.method} ${op.path} ${op.summary ?? ""} ${op.operationId ?? ""}`, query),
    );
    const groups = new Map<string, OperationSpec[]>();
    for (const op of matches) {
      if (!groups.has(op.tag)) groups.set(op.tag, []);
      groups.get(op.tag)!.push(op);
    }
    // Deprecated operations sort last within their group.
    for (const list of groups.values()) {
      list.sort((a, b) => Number(a.deprecated) - Number(b.deprecated) || a.path.localeCompare(b.path));
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [spec.operations, query]);

  const schemas: SchemaEntry[] = useMemo(
    () => spec.schemas.filter((s) => fuzzy(s.name, query)),
    [spec.schemas, query],
  );

  return (
    <aside className="sidebar" aria-label={tab === "schemas" ? "Schemas" : "Operations and history"}>
      {tab === "schemas" ? (
        <div className="history-side-head">
          <h2>Schemas</h2>
          <span className="meta">{spec.schemas.length}</span>
        </div>
      ) : (
        <TabList<SidebarTab>
          className="tabs"
          tabClassName="tab"
          label="Operations or history"
          tabs={[
            {
              id: "operations",
              label: (
                <>
                  Operations <span className="meta">{spec.operations.length}</span>
                </>
              ),
            },
            {
              id: "history",
              label: (
                <>
                  History <span className="meta">{history.length}</span>
                </>
              ),
            },
          ]}
          selected={tab}
          onSelect={onTabChange}
        />
      )}

      <div className="search">
        <input
          id="sidebar-search"
          value={query}
          placeholder={
            tab === "operations"
              ? "Search operations…"
              : tab === "schemas"
                ? "Search schemas…"
                : "Search history…"
          }
          onChange={(event) => onQueryChange(event.target.value)}
        />
      </div>

      <div className="list">
        {tab === "operations" &&
          groupedOperations.map(([tag, ops]) => (
            <div key={tag}>
              <div className="group-label">{tag}</div>
              {ops.map((op) => (
                <button
                  key={op.id}
                  className={`row${op.deprecated ? " deprecated" : ""}`}
                  aria-selected={selectedOperation === op.id}
                  onClick={() => onSelectOperation(op)}
                  onContextMenu={
                    onOperationMenu
                      ? (event) => {
                          event.preventDefault();
                          onOperationMenu(op, { x: event.clientX, y: event.clientY });
                        }
                      : undefined
                  }
                  onKeyDown={
                    onOperationMenu
                      ? (event) => {
                          // The keyboard's way to a context menu, where the platform has no menu key.
                          if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") {
                            event.preventDefault();
                            const rect = event.currentTarget.getBoundingClientRect();
                            onOperationMenu(op, { x: rect.left + 24, y: rect.bottom });
                          }
                        }
                      : undefined
                  }
                  aria-haspopup={onOperationMenu ? "menu" : undefined}
                  title={op.summary}
                >
                  <span className={`method ${op.method.toLowerCase()}`}>{op.method}</span>
                  <span style={{ minWidth: 0, display: "grid" }}>
                    <span className="path">{op.path}</span>
                    {op.summary && <span className="summary">{op.summary}</span>}
                  </span>
                </button>
              ))}
            </div>
          ))}

        {tab === "schemas" &&
          schemas.map((entry) => (
            <button
              key={entry.name}
              className="row"
              aria-selected={selectedSchema === entry.name}
              onClick={() => onSelectSchema(entry.name)}
            >
              <span className="path" style={{ flex: 1 }}>
                {entry.name}
              </span>
              {entry.usedIn > 0 && <span className="count">{entry.usedIn}</span>}
            </button>
          ))}

        {tab === "history" && (
          <>
            <HistoryList
              entries={searchHistory(history, query)}
              selectedId={selectedRecord}
              onOpen={onOpenRecord}
            />
            {history.length === 0 && (
              <div className="group-label">
                Nothing sent to this API yet — history stays on this machine
              </div>
            )}
            <button className="btn history-more" onClick={onOpenAllHistory}>
              All history, every API
            </button>
          </>
        )}

        {tab === "operations" && groupedOperations.length === 0 && (
          <div className="group-label">No matching operations</div>
        )}
        {tab === "schemas" && schemas.length === 0 && (
          <div className="group-label">No matching schemas</div>
        )}
      </div>
    </aside>
  );
}
