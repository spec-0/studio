import { useMemo } from "react";
import type { OperationSpec, ParsedSpec, SchemaEntry } from "../lib/spec";
import { relativeTime, search as searchHistory, type HistoryEntry } from "../lib/history";

export type SidebarTab = "operations" | "schemas" | "history";

interface Props {
  spec: ParsedSpec;
  tab: SidebarTab;
  onTabChange: (tab: SidebarTab) => void;
  query: string;
  onQueryChange: (query: string) => void;
  selectedOperation: string | null;
  onSelectOperation: (op: OperationSpec) => void;
  selectedSchema: string | null;
  onSelectSchema: (name: string) => void;
  history: HistoryEntry[];
  onReplay: (entry: HistoryEntry) => void;
  onClearHistory: () => void;
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
  onReplay,
  onClearHistory,
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
    <aside className="sidebar">
      <div className="tabs" role="tablist">
        <button
          className="tab"
          role="tab"
          aria-selected={tab === "operations"}
          onClick={() => onTabChange("operations")}
        >
          Operations <span className="meta">{spec.operations.length}</span>
        </button>
        <button
          className="tab"
          role="tab"
          aria-selected={tab === "schemas"}
          onClick={() => onTabChange("schemas")}
        >
          Schemas <span className="meta">{spec.schemas.length}</span>
        </button>
        <button
          className="tab"
          role="tab"
          aria-selected={tab === "history"}
          onClick={() => onTabChange("history")}
        >
          History <span className="meta">{history.length}</span>
        </button>
      </div>

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
            {searchHistory(history, query).map((entry) => (
              <button
                key={entry.id}
                className="row"
                onClick={() => onReplay(entry)}
                title={`${entry.url}\n${entry.status} · ${entry.ms}ms`}
              >
                <span className={`method ${entry.method.toLowerCase()}`}>{entry.method}</span>
                <span style={{ minWidth: 0, display: "grid", flex: 1 }}>
                  <span className="path">{entry.path}</span>
                  <span className="summary">
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
            {history.length === 0 && (
              <div className="group-label">Nothing sent yet — history stays on this machine</div>
            )}
            {history.length > 0 && (
              <button className="btn" style={{ margin: 10 }} onClick={onClearHistory}>
                Clear history
              </button>
            )}
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
