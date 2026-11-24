import { useEffect, useMemo, useState } from "react";
import {
  apiChoices,
  filterHistory,
  type HistoryEntry,
  type HistoryFilter,
  type StatusClass,
} from "../lib/history";
import type { ParsedSpec } from "../lib/spec";
import { HistoryDetail } from "./HistoryDetail";
import { HistoryList } from "./HistoryList";
import { History as HistoryIcon, MoreHorizontal, Search } from "lucide-react";
import { ContextMenu } from "./ContextMenu";
import { EmptyState } from "./EmptyState";

interface Props {
  entries: HistoryEntry[];
  /** Open with this entry selected, e.g. when arriving from an API's own list. */
  initialId?: string | null;
  /** Start filtered to one API (an {@link apiKey}). */
  initialApi?: string;
  /** The current spec for an entry's API, or null if it isn't in the library. */
  specFor: (entry: HistoryEntry) => Promise<ParsedSpec | null>;
  onCopy: (entry: HistoryEntry, destination: "operation" | "scratch") => void;
  onClear: () => void;
  /** "Add to collection" on the open entry, with the spec its API has now. */
  onAddToCollection?: (entry: HistoryEntry, position: { x: number; y: number }, spec: ParsedSpec | null) => void;
}

/**
 * Every recorded request, across all APIs and the scratch requests, in one list.
 *
 * The list is the log; the right-hand side reads one entry. Filters are the few
 * questions people actually ask of a log (which API, did it fail, did it
 * drift, was it a mock), plus text search.
 */
export function HistoryView({
  entries,
  initialId = null,
  initialApi,
  specFor,
  onCopy,
  onClear,
  onAddToCollection,
}: Props) {
  const [filter, setFilter] = useState<HistoryFilter>({ api: initialApi });
  const [selectedId, setSelectedId] = useState<string | null>(initialId);
  const [spec, setSpec] = useState<{ id: string; spec: ParsedSpec | null } | null>(null);

  const apis = useMemo(() => apiChoices(entries), [entries]);
  const shown = useMemo(() => filterHistory(entries, filter), [entries, filter]);
  const selected = entries.find((entry) => entry.id === selectedId) ?? null;

  useEffect(() => {
    if (!selected) return;
    let live = true;
    void specFor(selected).then((next) => {
      if (live) setSpec({ id: selected.id, spec: next });
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const patch = (next: Partial<HistoryFilter>) => setFilter((prev) => ({ ...prev, ...next }));
  const filtered = Boolean(
    filter.api || filter.status || filter.driftOnly || filter.target || filter.query,
  );

  return (
    <div className="panes">
      <aside className="sidebar history-side">
        <div className="history-side-head">
          <h2>History</h2>
          <span className="meta mono">{filtered ? `${shown.length} of ${entries.length}` : entries.length}</span>
          <span className="spacer" />
          <button
            className="icon-btn"
            aria-label="More"
            aria-haspopup="menu"
            title="More"
            disabled={entries.length === 0}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setMenu({ x: rect.left, y: rect.bottom + 4 });
            }}
          >
            <MoreHorizontal size={15} />
          </button>
        </div>
        <div className="search">
          <label className="filter-field">
            <Search size={13} aria-hidden />
            <input
              id="sidebar-search"
              value={filter.query ?? ""}
              placeholder="Filter by path, status or API"
              onChange={(event) => patch({ query: event.target.value })}
            />
            <span className="kbd">/</span>
          </label>
        </div>
        <div className="history-filters">
          <select
            className="fchip"
            aria-label="API"
            value={filter.api ?? ""}
            onChange={(event) => patch({ api: event.target.value || undefined })}
          >
            <option value="">All APIs</option>
            {apis.map((api) => (
              <option key={api.key} value={api.key}>
                {api.label} ({api.count})
              </option>
            ))}
          </select>
          <select
            className="fchip"
            aria-label="Status"
            value={filter.status ?? ""}
            onChange={(event) =>
              patch({ status: (event.target.value || undefined) as StatusClass | undefined })
            }
          >
            <option value="">Any status</option>
            <option value="2xx">2xx</option>
            <option value="3xx">3xx</option>
            <option value="4xx">4xx</option>
            <option value="5xx">5xx</option>
            <option value="errors">Errors (4xx, 5xx)</option>
          </select>
          <select
            className="fchip"
            aria-label="Mock or real"
            value={filter.target ?? ""}
            onChange={(event) =>
              patch({ target: (event.target.value || undefined) as "mock" | "real" | undefined })
            }
          >
            <option value="">Mock and real</option>
            <option value="mock">Mock only</option>
            <option value="real">Real only</option>
          </select>
          <button
            type="button"
            className={`fchip${filter.driftOnly ? " on" : ""}`}
            aria-pressed={Boolean(filter.driftOnly)}
            onClick={() => patch({ driftOnly: filter.driftOnly ? undefined : true })}
          >
            Drift only
          </button>
        </div>
        <div className="list">
          <HistoryList
            entries={shown}
            selectedId={selectedId}
            onOpen={(entry) => setSelectedId(entry.id)}
            showApi
          />
          {entries.length === 0 && (
            <div className="group-label">Nothing sent yet. History stays on this machine.</div>
          )}
          {entries.length > 0 && shown.length === 0 && (
            <div className="group-label">Nothing matches these filters</div>
          )}

        </div>
        <p className="meta list-foot">Kept 30 days, only on this computer. Never synced.</p>
        {menu && (
          <ContextMenu
            x={menu.x}
            y={menu.y}
            label="History"
            onClose={() => setMenu(null)}
            items={[{ label: "Clear all history…", onSelect: onClear }]}
          />
        )}
      </aside>

      <div className="workarea">
        {selected ? (
          <HistoryDetail
            key={selected.id}
            entry={selected}
            spec={spec?.id === selected.id ? spec.spec : null}
            specLoading={spec?.id !== selected.id}
            onCopy={onCopy}
            onAddToCollection={
              onAddToCollection
                ? (entry, position) => onAddToCollection(entry, position, spec?.id === entry.id ? spec.spec : null)
                : undefined
            }
            onClose={() => setSelectedId(null)}
          />
        ) : (
          <EmptyState
            icon={<HistoryIcon size={18} />}
            title="No request selected"
            body="Pick a request to see what was sent and what came back."
          />
        )}
      </div>
    </div>
  );
}
