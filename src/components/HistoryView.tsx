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

interface Props {
  entries: HistoryEntry[];
  /** Open with this entry selected, e.g. when arriving from an API's own list. */
  initialId?: string | null;
  /** Start filtered to one API — an {@link apiKey}. */
  initialApi?: string;
  /** The current spec for an entry's API, or null if it isn't in the library. */
  specFor: (entry: HistoryEntry) => Promise<ParsedSpec | null>;
  onCopy: (entry: HistoryEntry, destination: "operation" | "scratch") => void;
  onClear: () => void;
}

/**
 * Every recorded request, across all APIs and the scratch pad, in one list.
 *
 * The list is the log; the right-hand side reads one entry. Filters are the few
 * questions people actually ask of a log — which API, did it fail, did it
 * drift, was it a mock — plus text search.
 */
export function HistoryView({ entries, initialId = null, initialApi, specFor, onCopy, onClear }: Props) {
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

  const patch = (next: Partial<HistoryFilter>) => setFilter((prev) => ({ ...prev, ...next }));
  const filtered = Boolean(
    filter.api || filter.status || filter.driftOnly || filter.target || filter.query,
  );

  return (
    <div className="panes">
      <aside className="sidebar history-side">
        <div className="history-side-head">
          <h2>History</h2>
          <span className="meta">
            {filtered ? `${shown.length} of ${entries.length}` : entries.length}
          </span>
        </div>
        <div className="search">
          <input
            id="sidebar-search"
            value={filter.query ?? ""}
            placeholder="Search history…"
            onChange={(event) => patch({ query: event.target.value })}
          />
        </div>
        <div className="history-filters">
          <select
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
          <label className="history-check">
            <input
              type="checkbox"
              checked={Boolean(filter.driftOnly)}
              onChange={(event) => patch({ driftOnly: event.target.checked || undefined })}
            />
            Drift only
          </label>
        </div>
        <div className="list">
          <HistoryList
            entries={shown}
            selectedId={selectedId}
            onOpen={(entry) => setSelectedId(entry.id)}
            showApi
          />
          {entries.length === 0 && (
            <div className="group-label">Nothing sent yet — history stays on this machine</div>
          )}
          {entries.length > 0 && shown.length === 0 && (
            <div className="group-label">Nothing matches these filters</div>
          )}
          {entries.length > 0 && (
            <button className="btn" style={{ margin: 10 }} onClick={onClear}>
              Clear all history
            </button>
          )}
        </div>
      </aside>

      <div className="workarea">
        {selected ? (
          <HistoryDetail
            key={selected.id}
            entry={selected}
            spec={spec?.id === selected.id ? spec.spec : null}
            specLoading={spec?.id !== selected.id}
            onCopy={onCopy}
            onClose={() => setSelectedId(null)}
          />
        ) : (
          <div className="empty">
            <p>
              Pick a request to see what was sent and what came back. History is kept for 30 days
              and never leaves this machine.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
