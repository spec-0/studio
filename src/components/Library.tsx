import { useMemo, useState, type CSSProperties } from "react";
import {
  ArrowDownToLine,
  Cloud,
  FileJson,
  Link2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ServerCog,
  SquareDashed,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { mockIsBehind } from "../lib/sync";
import { relativeTime, sourceLabel, spec0ApiIdOf, type ApiSource, type LibraryEntry } from "../lib/library";
import { journeyAvailable } from "../lib/mockJourney";
import { Wordmark } from "./Logo";
import { shortcut } from "../lib/platform";
import { SWAGGER2_CONVERT_COMMAND, SWAGGER2_ISSUE_URL } from "../lib/spec";
import { openInBrowser } from "../lib/store";

function SourceIcon({ kind }: { kind: ApiSource["kind"] }) {
  const size = 11;
  if (kind === "url") return <Link2 size={size} />;
  if (kind === "spec0") return <Cloud size={size} />;
  if (kind === "sample") return <Sparkles size={size} />;
  return <FileJson size={size} />;
}

/**
 * The library's load error. A Swagger 2.0 document gets two small actions: copy the
 * local conversion command, and open the tracking issue in the browser.
 */
function LoadError({ error, style }: { error: string; style?: CSSProperties }) {
  const swagger2 = error.includes(SWAGGER2_CONVERT_COMMAND);
  return (
    <div className="error-box" style={style}>
      {error}
      {swagger2 && (
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button
            className="btn"
            onClick={() => void navigator.clipboard.writeText(SWAGGER2_CONVERT_COMMAND)}
          >
            Copy command
          </button>
          <button className="btn" onClick={() => void openInBrowser(SWAGGER2_ISSUE_URL)}>
            Swagger 2.0 support on GitHub
          </button>
        </div>
      )}
    </div>
  );
}

interface Props {
  entries: LibraryEntry[];
  onOpen: (entry: LibraryEntry) => void;
  onRemove: (entry: LibraryEntry) => void;
  onRename: (entry: LibraryEntry, title: string) => void;
  onRefresh: (entry: LibraryEntry) => void;
  onAdd: () => void;
  /** Refreshing a spec0-sourced API needs a connection; the button explains itself when not. */
  connected: boolean;
  onCheckUpdates: () => void;
  onApplyUpdate: (entry: LibraryEntry) => void;
  /** Rebuild an entry's mock against the spec we hold. Absent when disconnected. */
  onRefreshMock?: (entry: LibraryEntry) => void;
  /** Create a mock for an entry, or show the one it has (address, key, rebuild). */
  onMock: (entry: LibraryEntry) => void;
  checking: boolean;
  /** What the last applied update did to local state, if anything worth saying. */
  syncReport: { title: string; lines: string[] } | null;
  onDismissReport: () => void;
  onTrySample: () => void;
  /** Open the one scratch pad. Fixed, unnamed and not removable by design. */
  onOpenScratch: () => void;
  dragging: boolean;
  busy: string | null;
  error: string | null;
}

/**
 * The home surface: the APIs you work with.
 *
 * This exists because opening a spec used to *be* the application — one document,
 * no way back, no way to hold two at once. An engineer works across several APIs
 * in a week, so the app's root has to be the set of them, not whichever one was
 * opened last.
 */
export function Library({
  entries,
  onOpen,
  onRemove,
  onRename,
  onRefresh,
  onAdd,
  connected,
  onCheckUpdates,
  onApplyUpdate,
  onRefreshMock,
  onMock,
  checking,
  syncReport,
  onDismissReport,
  onTrySample,
  onOpenScratch,
  dragging,
  busy,
  error,
}: Props) {
  const [filter, setFilter] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter((entry) =>
      `${entry.title} ${sourceLabel(entry.source)}`.toLowerCase().includes(needle),
    );
  }, [entries, filter]);

  if (!entries.length) {
    return (
      <div className={`empty${dragging ? " dragging" : ""}`}>
        <div className="empty-brand">
          <Wordmark height={30} />
        </div>
        <h1>Your OpenAPI spec, explorable.</h1>
        <p>
          Browse operations and schemas as a real structure. Fire requests against your API or a
          mock. No account, no workspace — just the spec.
        </p>
        <div className="drop">Drop an OpenAPI file here, or {shortcut("O")} to add one</div>
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button className="btn primary" onClick={onAdd}>
            <Plus size={13} /> Add an API
          </button>
          <button className="btn" onClick={onTrySample}>
            <Sparkles size={13} /> Try a sample API
          </button>
        </div>
        <button className="btn" style={{ marginTop: 14 }} onClick={onOpenScratch}>
          <SquareDashed size={13} /> Or send one request without a spec
        </button>
        {busy && <p className="meta" style={{ marginTop: 12 }}>{busy}</p>}
        {error && <LoadError error={error} />}
      </div>
    );
  }

  return (
    <div className={`library${dragging ? " dragging" : ""}`}>
      <div className="library-head">
        <div>
          <h1>Your APIs</h1>
          <p className="meta">
            {entries.length} in your library · stored on this machine, no account needed
          </p>
        </div>
        <span className="spacer" />
        <div className="library-search">
          <Search size={13} />
          <input
            className="library-filter"
            placeholder="Filter…"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
        {connected && (
          <button className="btn" onClick={onCheckUpdates} disabled={checking}>
            <RefreshCw size={13} className={checking ? "spin" : undefined} />
            {checking ? "Checking…" : "Check for updates"}
          </button>
        )}
        <button className="btn primary" onClick={onAdd}>
          <Plus size={13} /> Add API <span className="kbd">{shortcut("O")}</span>
        </button>
      </div>

      {syncReport && (
        <div className="sync-report">
          <div className="sync-report-head">
            <strong>{syncReport.title} updated</strong>
            <span className="spacer" />
            <button className="icon-btn tight" onClick={onDismissReport} aria-label="Dismiss">
              <X size={13} />
            </button>
          </div>
          {syncReport.lines.length ? (
            <ul>
              {syncReport.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : (
            <p className="meta">Nothing you had set up was affected.</p>
          )}
        </div>
      )}

      {busy && <div className="verdict none">{busy}</div>}
      {error && <LoadError error={error} style={{ marginTop: 0 }} />}

      <div className="library-grid">
        {/* Pinned, unnamed, and outside `entries` — so "there is only ever one, and
            you can't delete it" is structural rather than a rule someone has to
            remember. */}
        {!filter.trim() && (
          <button className="api-card scratch" onClick={onOpenScratch}>
            <div className="api-card-top">
              <span className="api-title">
                <SquareDashed size={13} /> Scratch
              </span>
            </div>
            <p className="meta">
              One ad-hoc request — method, URL, headers, body. No spec, so nothing is generated or
              checked.
            </p>
            <div className="api-card-foot">
              <span className="meta">not saved · holds whatever you last typed</span>
            </div>
          </button>
        )}

        {shown.map((entry) => (
          <div key={entry.id} className="api-card" onDoubleClick={() => onOpen(entry)}>
            <div className="api-card-top">
              {renaming === entry.id ? (
                <input
                  autoFocus
                  value={draftName}
                  onChange={(event) => setDraftName(event.target.value)}
                  onBlur={() => {
                    if (draftName.trim()) onRename(entry, draftName.trim());
                    setRenaming(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                    if (event.key === "Escape") setRenaming(null);
                  }}
                />
              ) : (
                <button className="api-title" onClick={() => onOpen(entry)}>
                  {entry.title}
                </button>
              )}
              {entry.version && <span className="spec-version">{entry.version}</span>}
            </div>

            <div className="api-card-meta">
              <span className={`tag src-${entry.source.kind}`}>
                <SourceIcon kind={entry.source.kind} />
                {entry.source.kind}
              </span>
              <span className="meta" title={entry.source.ref}>
                {sourceLabel(entry.source)}
              </span>
            </div>

            <div className="api-card-stats">
              <span>
                <strong>{entry.operations}</strong> operations
              </span>
              <span>
                <strong>{entry.schemas}</strong> schemas
              </span>
            </div>

            {entry.update && (
              <button className="update-pill" onClick={() => onApplyUpdate(entry)}>
                <ArrowDownToLine size={11} />
                Update available
                {entry.update.version && entry.version
                  ? ` · ${entry.version} → ${entry.update.version}`
                  : ""}
              </button>
            )}

            {onRefreshMock && mockIsBehind(entry) && (
              <button
                className="update-pill mock"
                onClick={() => onRefreshMock(entry)}
                title="The mock still serves an older version of this spec"
              >
                <ServerCog size={11} />
                Mock is behind
                {entry.mockSpecVersion && entry.version
                  ? ` · ${entry.mockSpecVersion} → ${entry.version}`
                  : ""}
              </button>
            )}

            <div className="api-card-foot">
              <span className="meta">
                opened {relativeTime(entry.openedAt)}
                {entry.syncedAt ? ` · pulled ${relativeTime(entry.syncedAt)}` : ""}
              </span>
              <span className="spacer" />
              {entry.mockUrl ? (
                <button
                  className="btn ghost card-mock"
                  onClick={() => onMock(entry)}
                  title="The mock's address and key; rebuild it"
                >
                  <ServerCog size={12} /> Mock
                </button>
              ) : (
                journeyAvailable({ apiId: spec0ApiIdOf(entry), sourceKind: entry.source.kind }) && (
                  <button
                    className="btn card-mock"
                    onClick={() => onMock(entry)}
                    title="Create a hosted mock server for this API"
                  >
                    <Plus size={12} /> Create mock
                  </button>
                )
              )}
              <div className="api-card-actions">
                {entry.source.kind !== "sample" && (
                  <button
                    className="icon-btn tight"
                    disabled={entry.source.kind === "spec0" && !connected}
                    onClick={() => onRefresh(entry)}
                    title={
                      entry.source.kind === "spec0" && !connected
                        ? "Connect to spec0 to re-pull this API"
                        : "Re-read from source"
                    }
                    aria-label="Refresh"
                  >
                    <RefreshCw size={13} />
                  </button>
                )}
                <button
                  className="icon-btn tight"
                  title="Rename"
                  aria-label="Rename"
                  onClick={() => {
                    setRenaming(entry.id);
                    setDraftName(entry.title);
                  }}
                >
                  <Pencil size={13} />
                </button>
                <button
                  className="icon-btn tight danger"
                  onClick={() => onRemove(entry)}
                  title="Remove from library"
                  aria-label="Remove"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>

            <button className="api-card-open" onClick={() => onOpen(entry)}>
              Open
            </button>
          </div>
        ))}
      </div>

      {shown.length === 0 && <p className="meta">Nothing matches “{filter}”.</p>}
    </div>
  );
}
