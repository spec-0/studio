import { useMemo, useState, type CSSProperties } from "react";
import {
  ArrowDownToLine,
  Cloud,
  FileJson,
  Link2,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  ServerCog,
  SquareDashed,
  Sparkles,
  X,
} from "lucide-react";
import { mockIsBehind } from "../lib/sync";
import { relativeTime, sourceLabel, spec0ApiIdOf, type ApiSource, type LibraryEntry } from "../lib/library";
import { journeyAvailable } from "../lib/mockJourney";
import { LocalMockControl } from "./LocalMockControl";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import type { OpenTab } from "../hooks/useDialogs";
import { LogoMark } from "./Logo";
import { shortcut } from "../lib/platform";
import { SWAGGER2_CONVERT_COMMAND } from "../lib/spec";

function SourceIcon({ kind }: { kind: ApiSource["kind"] }) {
  const size = 11;
  if (kind === "url") return <Link2 size={size} />;
  if (kind === "spec0") return <Cloud size={size} />;
  if (kind === "sample") return <Sparkles size={size} />;
  return <FileJson size={size} />;
}

/**
 * The library's load error. A Swagger 2.0 document Studio couldn't convert gets
 * one small action: copy the command that converts it locally.
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
        </div>
      )}
    </div>
  );
}

/** When an entry was last opened and pulled, as the card's footer says it. */
function openedLabel(entry: LibraryEntry): string {
  const pulled = entry.syncedAt ? ` · pulled ${relativeTime(entry.syncedAt)}` : "";
  return `opened ${relativeTime(entry.openedAt)}${pulled}`;
}

/** "opened 2m ago" → "Opened 2m ago". */
const sentenceCase = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

interface Props {
  entries: LibraryEntry[];
  onOpen: (entry: LibraryEntry) => void;
  onRemove: (entry: LibraryEntry) => void;
  onRename: (entry: LibraryEntry, title: string) => void;
  onRefresh: (entry: LibraryEntry) => void;
  /** Add an API, on a given source when the first-run screen chose one. */
  onAdd: (tab?: OpenTab) => void;
  /** Refreshing a spec0-sourced API needs a connection; the button explains itself when not. */
  connected: boolean;
  onCheckUpdates: () => void;
  onApplyUpdate: (entry: LibraryEntry) => void;
  /** Rebuild an entry's mock against the spec we hold. Absent when disconnected. */
  onRefreshMock?: (entry: LibraryEntry) => void;
  /** Create a mock for an entry, or show the one it has (address, key, rebuild). */
  onMock: (entry: LibraryEntry) => void;
  /** Local mocks: which entries are served on this computer, and the actions. Absent outside the desktop app. */
  localMock?: {
    running: Record<string, number>;
    busy: string | null;
    error: { id: string; message: string } | null;
    onStart: (entry: LibraryEntry) => void;
    onStop: (id: string) => void;
  };
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
 * An engineer works across several APIs in a week, so the app's root is the set
 * of them, not whichever one was opened last.
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
  localMock,
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
  const [menu, setMenu] = useState<{ position: { x: number; y: number }; items: MenuItem[] } | null>(null);

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter((entry) =>
      `${entry.title} ${sourceLabel(entry.source)}`.toLowerCase().includes(needle),
    );
  }, [entries, filter]);

  if (!entries.length) {
    return (
      <div className={`page first-run${dragging ? " dragging" : ""}`}>
        <div className="page-in narrow">
          <div className="first-run-brand" aria-hidden>
            <LogoMark size={22} />
          </div>
          <h1 className="page-title">Open your first API</h1>
          <p className="desc">
            Studio builds requests, checks and mocks from an OpenAPI spec. Everything stays on this computer; no
            account needed. You can also drop a spec anywhere on this window.
          </p>
          <div className="start-grid">
            <button className="start-card" onClick={() => onAdd("file")}>
              <span className="start-icon">
                <FileJson size={16} />
              </span>
              <b>Open a file</b>
              <span className="meta">OpenAPI 3.0 or 3.1, or Swagger 2.0, in YAML or JSON.</span>
              <span className="kbd">{shortcut("O")}</span>
            </button>
            <button className="start-card" onClick={() => onAdd("url")}>
              <span className="start-icon">
                <Link2 size={16} />
              </span>
              <b>Import from a URL</b>
              <span className="meta">A spec served over HTTP, re-read when you refresh it.</span>
            </button>
            <button className="start-card" onClick={() => onAdd("spec0")}>
              <span className="start-icon">
                <Cloud size={16} />
              </span>
              <b>From Spec0</b>
              <span className="meta">Your organisation's APIs, if your team uses Spec0.</span>
            </button>
          </div>
          <div className="start-quiet">
            <button className="btn ghost" onClick={onTrySample}>
              <Sparkles size={13} /> Try the sample API
            </button>
            <button className="btn ghost" onClick={onOpenScratch}>
              <SquareDashed size={13} /> Send one request without a spec
            </button>
          </div>
          {busy && <p className="meta" style={{ marginTop: 12 }}>{busy}</p>}
          {error && <LoadError error={error} />}
        </div>
      </div>
    );
  }

  const cardMenu = (entry: LibraryEntry, position: { x: number; y: number }) =>
    setMenu({
      position,
      items: [
        { label: "Open", onSelect: () => onOpen(entry) },
        ...(entry.source.kind !== "sample"
          ? [
              {
                label: "Re-read from source",
                disabled: entry.source.kind === "spec0" && !connected,
                onSelect: () => onRefresh(entry),
              },
            ]
          : []),
        {
          label: "Rename…",
          onSelect: () => {
            setRenaming(entry.id);
            setDraftName(entry.title);
          },
        },
        ...(entry.mockUrl
          ? [{ label: "Hosted mock…", onSelect: () => onMock(entry) }]
          : journeyAvailable({ apiId: spec0ApiIdOf(entry), sourceKind: entry.source.kind })
            ? [{ label: "Create hosted mock…", onSelect: () => onMock(entry) }]
            : []),
        { label: "Remove from library", separator: true, onSelect: () => onRemove(entry) },
      ],
    });

  return (
    <div className={`page library${dragging ? " dragging" : ""}`}>
      <div className="page-in">
        <div className="page-head">
          <div className="l">
            <h1 className="page-title">APIs</h1>
            <p className="desc">
              {entries.length} in your library, stored on this computer. No account needed.
            </p>
          </div>
          <div className="btn-row">
            <label className="filter-field library-filter">
              <Search size={13} aria-hidden />
              <input placeholder="Filter APIs" value={filter} onChange={(event) => setFilter(event.target.value)} />
            </label>
            {connected && (
              <button className="btn" onClick={onCheckUpdates} disabled={checking}>
                <RefreshCw size={13} className={checking ? "spin" : undefined} />
                {checking ? "Checking…" : "Check for updates"}
              </button>
            )}
            <button className="btn primary" onClick={() => onAdd()}>
              <Plus size={13} /> Add API <span className="kbd">{shortcut("O")}</span>
            </button>
          </div>
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
          {shown.map((entry) => {
            const port = localMock?.running[entry.id] ?? null;
            return (
              <div
                key={entry.id}
                className="api-card"
                data-source={entry.source.kind}
                onDoubleClick={() => onOpen(entry)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  cardMenu(entry, { x: event.clientX, y: event.clientY });
                }}
              >
                <div className="api-card-top">
                  {renaming === entry.id ? (
                    <input
                      autoFocus
                      className="input"
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
                  {entry.version && <span className="chip">{entry.version}</span>}
                  {entry.source.kind === "sample" && <span className="chip sans soft">sample</span>}
                  <span className="spacer" />
                  <button
                    className="icon-btn api-card-more"
                    aria-label={`More for ${entry.title}`}
                    aria-haspopup="menu"
                    title="More"
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      cardMenu(entry, { x: rect.left, y: rect.bottom + 4 });
                    }}
                  >
                    <MoreHorizontal size={15} />
                  </button>
                </div>

                <div className="api-card-src" title={entry.source.ref}>
                  <SourceIcon kind={entry.source.kind} />
                  <span className={entry.source.kind === "sample" ? "" : "mono"}>
                    {entry.source.kind === "sample" ? "Bundled with Studio" : sourceLabel(entry.source)}
                  </span>
                </div>

                <div className="api-card-stats">
                  <span>
                    <strong>{entry.operations}</strong> {entry.operations === 1 ? "operation" : "operations"}
                  </span>
                  <span>
                    <strong>{entry.schemas}</strong> {entry.schemas === 1 ? "schema" : "schemas"}
                  </span>
                </div>

                <div className="api-card-foot">
                  {port !== null && localMock ? (
                    <LocalMockControl
                      compact
                      port={port}
                      busy={localMock.busy === entry.id}
                      onStart={() => localMock.onStart(entry)}
                      onStop={() => localMock.onStop(entry.id)}
                    />
                  ) : entry.update ? (
                    <button className="chip sans warn update-chip" onClick={() => onApplyUpdate(entry)}>
                      <ArrowDownToLine size={11} /> Update available
                      {entry.update.version ? ` · ${entry.update.version}` : ""}
                    </button>
                  ) : onRefreshMock && mockIsBehind(entry) ? (
                    <button
                      className="chip sans warn update-chip"
                      onClick={() => onRefreshMock(entry)}
                      title="The hosted mock still serves an older version of this spec"
                    >
                      <ServerCog size={11} /> Mock is behind
                      {entry.mockSpecVersion && entry.version ? ` · ${entry.mockSpecVersion} → ${entry.version}` : ""}
                    </button>
                  ) : (
                    <span className="meta" title={openedLabel(entry)}>
                      {sentenceCase(openedLabel(entry))}
                    </span>
                  )}
                  <span className="spacer" />
                  {localMock && port === null && (
                    <LocalMockControl
                      compact
                      port={null}
                      busy={localMock.busy === entry.id}
                      error={localMock.error?.id === entry.id ? localMock.error.message : null}
                      onStart={() => localMock.onStart(entry)}
                      onStop={() => localMock.onStop(entry.id)}
                    />
                  )}
                </div>

                <button className="api-card-open" onClick={() => onOpen(entry)}>
                  Open
                </button>
              </div>
            );
          })}

          {/* Pinned, unnamed, and outside `entries`, so "there is only ever one, and
              you can't delete it" is structural rather than a rule someone has to
              remember. Last, and quiet. */}
          {!filter.trim() && (
            <button className="api-card scratch" onClick={onOpenScratch}>
              <div className="api-card-top">
                <span className="api-title">
                  <SquareDashed size={13} /> Scratch request
                </span>
              </div>
              <p className="meta">One request with no spec: method, URL, headers, body. Nothing is generated or checked.</p>
              <div className="api-card-foot">
                <span className="meta">Not saved · keeps what you last typed</span>
              </div>
            </button>
          )}
        </div>

        {shown.length === 0 && <p className="meta">Nothing matches “{filter}”.</p>}
      </div>
      {menu && (
        <ContextMenu
          x={menu.position.x}
          y={menu.position.y}
          items={menu.items}
          label="API"
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
