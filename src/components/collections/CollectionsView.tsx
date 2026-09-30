import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  FileText,
  FolderOpen,
  Import,
  MoreHorizontal,
  Play,
  Plus,
  Save,
  Square,
} from "lucide-react";
import { fieldsFromOutput, fieldsFromSchema } from "../../lib/chain";
import type { Collection } from "../../lib/collection";
import { findLibraryEntry, type StepLink } from "../../lib/collectionLink";
import { describeRun, summariseRun } from "../../lib/collectionRun";
import type { LibraryEntry } from "../../lib/library";
import { fileName, shortcut } from "../../lib/platform";
import { inTauri } from "../../lib/request";
import type { CollectionsApi } from "../../hooks/useCollections";
import { ContextMenu, type MenuItem } from "../ContextMenu";
import { LinkOperationDialog } from "./LinkOperationDialog";
import { StepEditor, type StepTab } from "./StepEditor";
import { StepList, stepTitle } from "./StepList";
import type { EarlierStep } from "./ValuePicker";

interface Props {
  api: CollectionsApi;
  entries: LibraryEntry[];
  /** Go to the library, to add or open an API. */
  onGoLibrary: () => void;
}

/**
 * The Collections tab: the list on the left, one collection on the right.
 */
export function CollectionsView({ api, entries, onGoLibrary }: Props) {
  const { collections, selected } = api;
  const importInput = useRef<HTMLInputElement>(null);

  return (
    <div className="panes collections">
      <aside className="sidebar collections-side" aria-label="Collections">
        <div className="history-side-head">
          <h2>Collections</h2>
          <span className="meta">{collections.length}</span>
          <span className="spacer" />
          <button type="button" className="icon-btn tight" aria-label="New collection" title="New collection" onClick={() => api.create()}>
            <Plus size={14} />
          </button>
        </div>
        <div className="collections-actions">
          {inTauri ? (
            <>
              <button type="button" className="btn" onClick={() => void api.openFromFile(true)} title="Open a collection file and keep it linked, e.g. in a git repository">
                <FolderOpen size={13} aria-hidden /> Open file…
              </button>
              <button type="button" className="btn" onClick={() => void api.openFromFile(false)} title="Import a copy of a collection file into Studio">
                <Import size={13} aria-hidden /> Import…
              </button>
            </>
          ) : (
            <button type="button" className="btn" onClick={() => importInput.current?.click()}>
              <Import size={13} aria-hidden /> Import…
            </button>
          )}
          <input
            ref={importInput}
            type="file"
            accept=".yaml,.yml"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void file.text().then((text) => api.addFromText(text, null, false));
            }}
          />
        </div>
        {api.openError && (
          <div className="error-box collections-error" role="alert">
            {api.openError}
          </div>
        )}
        <div className="list" role="list">
          {collections.map((collection) => {
            const run = api.runs[collection.id];
            const summary = run && !run.running ? summariseRun(run.results) : null;
            return (
              <button
                key={collection.id}
                type="button"
                role="listitem"
                className="row collection-row"
                aria-current={selected?.id === collection.id ? "true" : undefined}
                aria-selected={selected?.id === collection.id}
                onClick={() => api.select(collection.id)}
              >
                <span style={{ minWidth: 0, display: "grid", flex: 1 }}>
                  <span className="path collection-name">
                    {collection.name}
                    {collection.file?.dirty && <span className="dirty-dot" title="Unsaved changes" aria-label="unsaved changes" />}
                  </span>
                  <span className="summary">
                    {collection.steps.length} step{collection.steps.length === 1 ? "" : "s"}
                    {collection.file ? ` · ${fileName(collection.file.path)}` : " · in Studio"}
                  </span>
                </span>
                {summary && (
                  <span className={`run-dot ${summary.failed ? "fail" : "pass"}`} title={describeRun(summary)} />
                )}
              </button>
            );
          })}
          {api.loaded && !collections.length && (
            <div className="group-label">No collections yet</div>
          )}
        </div>
      </aside>

      <div className="workarea">
        {selected ? (
          <CollectionDetail key={selected.id} api={api} collection={selected} entries={entries} onGoLibrary={onGoLibrary} />
        ) : (
          <div className="empty">
            <h1>Collections</h1>
            <p>
              A collection runs steps in order, across your specs: create an order, get it, pay for it. Each step
              points at an operation, so its response is checked against that spec, and Studio tells you when a step no
              longer matches it.
            </p>
            <p>
              Right-click an operation and choose <strong>Add to collection</strong>, or add one from History.
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" className="btn primary" onClick={() => api.create()}>
                New collection
              </button>
              <button type="button" className="btn" onClick={onGoLibrary}>
                Go to your APIs
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function CollectionDetail({
  api,
  collection,
  entries,
  onGoLibrary,
}: {
  api: CollectionsApi;
  collection: Collection;
  entries: LibraryEntry[];
  onGoLibrary: () => void;
}) {
  const run = api.runs[collection.id];
  const running = Boolean(run?.running);
  const results = run?.results ?? [];
  const summary = run && !running ? summariseRun(results) : null;
  const notice = api.notices[collection.id];
  const conflict = api.conflicts[collection.id];
  const index = Math.min(api.selectedStep, Math.max(0, collection.steps.length - 1));
  const step = collection.steps[index];
  const link: StepLink | undefined = api.links[index];
  const [tab, setTab] = useState<StepTab>("request");
  const [pendingInsert, setPendingInsert] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[]; label: string } | null>(null);
  const [linking, setLinking] = useState(false);
  const [nameDraft, setNameDraft] = useState(collection.name);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => setNameDraft(collection.name), [collection.name]);

  // After a run, show the first failing step's response, since that's the question.
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) {
      const failed = results.findIndex((r) => r.verdict === "fail");
      if (failed >= 0) {
        api.setSelectedStep(failed);
        setTab("response");
      }
    }
    wasRunning.current = running;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  const runningIndex = running ? results.length : null;
  const unresolvedApis = useMemo(
    () =>
      Object.entries(collection.apis)
        .filter(([, a]) => !findLibraryEntry(a, entries))
        .map(([key, a]) => ({ key, api: a })),
    [collection.apis, entries],
  );

  /** Each earlier step's pickable values: from its last response, or its declared one. */
  const earlier: EarlierStep[] = useMemo(
    () =>
      collection.steps.slice(0, index).map((s, i) => {
        const title = `${i + 1}. ${stepTitle(collection, i)}`;
        const output = results.find((r) => r.key === s.key)?.output;
        if (output) return { key: s.key, title, fields: fieldsFromOutput(s.key, output), from: "response" as const };
        const l = api.links[i];
        if (l && (l.kind === "ok" || l.kind === "stale")) {
          const success = l.op.responses.find((r) => /^2/.test(r.status) && r.schema);
          if (success) return { key: s.key, title, fields: fieldsFromSchema(s.key, l.spec.doc, success.schema), from: "schema" as const };
        }
        return { key: s.key, title, fields: [], from: "none" as const };
      }),
    [collection, index, results, api.links],
  );

  const onChange = useCallback(
    (change: Parameters<CollectionsApi["updateStep"]>[2]) => api.updateStep(collection.id, index, change),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api.updateStep, collection.id, index],
  );
  const onInserted = useCallback(() => setPendingInsert(null), []);

  const copy = (reference: string) => {
    void navigator.clipboard?.writeText(reference).catch(() => {});
    setCopied(reference);
    window.setTimeout(() => setCopied((current) => (current === reference ? null : current)), 3500);
  };

  const moreItems: MenuItem[] = [
    ...(inTauri
      ? [
          {
            label: collection.file ? "Save to another file…" : "Save to a folder…",
            hint: "stays linked",
            onSelect: () => void api.saveToFolder(collection.id),
          },
        ]
      : []),
    { label: "Export a copy…", onSelect: () => void api.exportCollection(collection.id) },
    ...(collection.file ? [{ label: "Keep in Studio only", onSelect: () => api.stopLinking(collection.id) }] : []),
    {
      label: <span className="danger-ink">Delete collection</span>,
      text: "Delete collection",
      separator: true,
      onSelect: () => api.remove(collection.id),
    },
  ];

  return (
    <div className="collection">
      <header className="collection-head">
        <div className="collection-title-row">
          <input
            className="collection-title"
            aria-label="Collection name"
            value={nameDraft}
            onChange={(event) => setNameDraft(event.target.value)}
            onBlur={(event) => {
              // Read the field, not the draft: a blur can arrive before the last change renders.
              const name = event.currentTarget.value.trim();
              if (name && name !== collection.name) api.rename(collection.id, name);
              else setNameDraft(collection.name);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") (event.target as HTMLInputElement).blur();
            }}
          />
          <span className="spacer" />
          <label className="history-check" title="Stop at the first step that fails">
            <input
              type="checkbox"
              checked={collection.stopOnFailure}
              onChange={(event) => api.setStopOnFailure(collection.id, event.target.checked)}
            />
            Stop at first failure
          </label>
          {collection.file && (
            <button
              type="button"
              className="btn"
              disabled={!collection.file.dirty}
              onClick={() => void api.save(collection.id)}
              title={collection.file.dirty ? `Save to ${collection.file.path}` : "Saved"}
            >
              <Save size={13} aria-hidden /> {collection.file.dirty ? "Save" : "Saved"}
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            aria-label="More collection actions"
            aria-haspopup="menu"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setMenu({ x: rect.right - 200, y: rect.bottom + 4, items: moreItems, label: "Collection actions" });
            }}
          >
            <MoreHorizontal size={16} />
          </button>
          {running ? (
            <button type="button" className="btn" onClick={() => api.stop(collection.id)}>
              <Square size={12} aria-hidden /> Stop
            </button>
          ) : (
            <button
              type="button"
              className="btn primary"
              disabled={!collection.steps.length}
              onClick={() => void api.run(collection.id)}
              title={`Run every step in order`}
            >
              <Play size={13} aria-hidden /> Run
            </button>
          )}
        </div>
        <div className="collection-meta">
          <span className="meta">
            {collection.steps.length} step{collection.steps.length === 1 ? "" : "s"} ·{" "}
            {Object.keys(collection.apis).length} API{Object.keys(collection.apis).length === 1 ? "" : "s"}
          </span>
          {collection.file ? (
            <span className="tag src-file" title={collection.file.path}>
              <FileText size={11} aria-hidden /> {fileName(collection.file.path)}
              {collection.file.dirty ? " · unsaved" : ""}
            </span>
          ) : (
            <span className="tag">in Studio</span>
          )}
          {summary && (
            <span className={`meta ${summary.failed ? "warn" : ""}`} role="status">
              Last run: {describeRun(summary)}
            </span>
          )}
          {running && <span className="meta" role="status">Running step {results.length + 1} of {collection.steps.length}…</span>}
        </div>
      </header>

      {conflict && (
        <div className="verdict warn collection-banner" role="alert">
          <AlertTriangle size={14} aria-hidden className="glyph" />
          <span>
            {fileName(collection.file?.path ?? "")} changed on disk, and this collection has changes that aren't saved
            to it. Which do you want to keep?
          </span>
          <span className="spacer" />
          <button type="button" className="btn" onClick={() => api.resolveConflict(collection.id, "file")}>
            Use the file
          </button>
          <button type="button" className="btn" onClick={() => api.resolveConflict(collection.id, "mine")}>
            Keep mine
          </button>
        </div>
      )}
      {notice && (
        <div className={`verdict ${notice.kind === "info" ? "none" : "warn"} collection-banner`} role={notice.kind === "error" ? "alert" : "status"}>
          <span className="glyph">{notice.kind === "info" ? "i" : "!"}</span>
          <div>
            {notice.text}
            {notice.lines && (
              <ul>
                {notice.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </div>
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={() => api.notify(collection.id, null)}>
            Dismiss
          </button>
        </div>
      )}
      {unresolvedApis.map(({ key, api: missing }) => (
        <div className="verdict warn collection-banner" role="note" key={key}>
          <AlertTriangle size={14} aria-hidden className="glyph" />
          <span>
            {missing.title} isn't in your library
            {missing.source.kind === "file" || missing.source.kind === "url" ? ` (${missing.source.ref})` : ""}, so its
            steps can't run.
          </span>
          <span className="spacer" />
          {(missing.source.kind === "url" || (missing.source.kind === "file" && inTauri)) && (
            <button type="button" className="btn" onClick={() => void api.addApiToLibrary(missing.source, missing.title, collection.id)}>
              Add to library
            </button>
          )}
          {missing.source.kind !== "url" && !(missing.source.kind === "file" && inTauri) && (
            <button type="button" className="btn" onClick={onGoLibrary}>
              Go to your APIs
            </button>
          )}
        </div>
      ))}
      {copied && (
        <div className="verdict none collection-banner" role="status">
          <span className="glyph">i</span>
          <span>
            Copied <code>{copied}</code>. Paste it into a field.
          </span>
        </div>
      )}

      {collection.steps.length ? (
        <div className="collection-body">
          <div className="collection-steps">
            <StepList
              collection={collection}
              links={api.links}
              results={results}
              runningIndex={runningIndex}
              selected={index}
              onSelect={(i) => {
                api.setSelectedStep(i);
              }}
              onMove={(from, to) => api.moveStep(collection.id, from, to)}
            />
            <div className="field-meta step-list-hint">
              Drag to reorder, or {`Alt+↑ / Alt+↓`}. Right-click an operation in an API to add a step.
            </div>
          </div>
          {step && link && (
            <StepEditor
              step={step}
              index={index}
              total={collection.steps.length}
              link={link}
              mockUrl={link.kind === "ok" || link.kind === "stale" ? api.mockUrlFor(link.entry) : null}
              localMock={
                (link.kind === "ok" || link.kind === "stale") && api.localMocks.available
                  ? {
                      port: api.localMocks.running[link.entry.id] ?? null,
                      onStart: () => void api.localMocks.start(link.entry),
                    }
                  : null
              }
              earlier={earlier}
              result={results.find((r) => r.key === step.key)}
              running={running && runningIndex === index}
              tab={tab}
              onTab={setTab}
              onChange={onChange}
              onRenameKey={(to) => api.renameStepKey(collection.id, step.key, to)}
              onRemove={() => api.removeStep(collection.id, index)}
              onLink={() => setLinking(true)}
              pendingInsert={pendingInsert}
              onInserted={onInserted}
              onCopied={copy}
              revision={api.revision}
              onPickFromResponse={(reference, rect) => {
                const later = collection.steps
                  .map((_, i) => i)
                  .filter((i) => i > index);
                setMenu({
                  x: rect.left,
                  y: rect.bottom + 4,
                  label: "Use this value",
                  items: [
                    {
                      label: "Use in a later step",
                      text: "Use in a later step",
                      disabled: !later.length,
                      submenu: later.map((i) => ({
                        label: `${i + 1}. ${stepTitle(collection, i)}`,
                        onSelect: () => {
                          api.setSelectedStep(i);
                          setTab("request");
                          setPendingInsert(reference);
                        },
                      })),
                    },
                    { label: "Copy reference", hint: reference, onSelect: () => copy(reference) },
                  ],
                });
              }}
            />
          )}
        </div>
      ) : (
        <div className="empty">
          <p>
            No steps yet. Open an API, right-click an operation and choose <strong>Add to collection ▸ {collection.name}</strong>.
            You can also add a request from History.
          </p>
          <button type="button" className="btn" onClick={onGoLibrary}>
            Go to your APIs
          </button>
          <p className="meta">{shortcut("L")} opens the list of APIs.</p>
        </div>
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} label={menu.label} onClose={() => setMenu(null)} />}
      {linking && step && (
        <LinkOperationDialog
          entries={entries}
          initialEntryId={link && "entry" in link && link.entry ? link.entry.id : null}
          hint={
            step.operation
              ? `${step.operation.operationId ?? ""} ${step.operation.method} ${step.operation.path}`.trim()
              : `${step.request?.method ?? ""} ${step.request?.url ?? ""}`
          }
          loadSpec={api.specForEntry}
          onPick={(entry, op) => {
            api.relinkStep(collection.id, index, entry, op);
            setLinking(false);
          }}
          onClose={() => setLinking(false)}
        />
      )}
    </div>
  );
}
