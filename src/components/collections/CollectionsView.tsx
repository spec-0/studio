import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { fieldsFromOutput, fieldsFromSchema, findRefs, type ResolvedLink, type StepOutput } from "../../lib/chain";
import {
  analyseChain,
  bodyExampleAt,
  bodyProblem,
  checkLink,
  dependentsOf,
  describeLinkTarget,
  editLink,
  linkableFields,
  linksBrokenByMove,
  linkValue,
  removeLink,
  sameTarget,
  schemaTypeAt,
  setLink,
  stepLabel,
  type ChainLink,
  type LinkTarget,
  type LinkView,
  type SourceFacts,
} from "../../lib/chainLinks";
import type { Collection } from "../../lib/collection";
import { findLibraryEntry, type StepLink } from "../../lib/collectionLink";
import { describeRun, summariseRun } from "../../lib/collectionRun";
import { exampleFor, mediaExample } from "../../lib/example";
import type { LibraryEntry } from "../../lib/library";
import { fileName, shortcut } from "../../lib/platform";
import { inTauri } from "../../lib/request";
import { bodyModeFor } from "../../lib/spec";
import type { CollectionsApi } from "../../hooks/useCollections";
import { ConfirmDialog } from "../ConfirmDialog";
import { ContextMenu, type MenuItem } from "../ContextMenu";
import { TabList } from "../TabList";
import { ChainView } from "./ChainView";
import { ImportSummaryDialog } from "./ImportSummaryDialog";
import { LinkDialog, type LinkDraft, type StepFields, type StepTargets } from "./LinkDialog";
import { LinkOperationDialog } from "./LinkOperationDialog";
import { RunLogView } from "./RunLogView";
import { StepEditor, type StepChain, type StepTab } from "./StepEditor";
import { StepList, stepTitle } from "./StepList";

interface Props {
  api: CollectionsApi;
  entries: LibraryEntry[];
  /** Go to the library, to add or open an API. */
  onGoLibrary: () => void;
}

/** An "are you sure?" waiting for an answer. */
interface Confirming {
  title: string;
  body: ReactNode;
  confirm: string;
  danger?: boolean;
  run: () => void;
}

type Menu = { x: number; y: number; items: MenuItem[]; label: string };

/**
 * The Collections tab: the list on the left, one collection on the right.
 */
export function CollectionsView({ api, entries, onGoLibrary }: Props) {
  const { collections, selected } = api;
  const importInput = useRef<HTMLInputElement>(null);
  const [dropping, setDropping] = useState(false);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  /** Only files: dragging a step to reorder it is a drag too. */
  const carriesFiles = (event: React.DragEvent) => [...event.dataTransfer.types].includes("Files");

  const confirmDelete = (collection: Collection) =>
    setConfirming({
      title: `Delete “${collection.name}”?`,
      body: (
        <p>
          Its {collection.steps.length} step{collection.steps.length === 1 ? "" : "s"} will be removed from Studio.
          {collection.file ? ` The file ${fileName(collection.file.path)} stays where it is.` : " This can't be undone."}
        </p>
      ),
      confirm: "Delete collection",
      danger: true,
      run: () => api.remove(collection.id),
    });

  const rowMenu = (collection: Collection, at: { x: number; y: number }) =>
    setMenu({
      ...at,
      label: `Actions for ${collection.name}`,
      items: [
        { label: "Rename…", onSelect: () => api.requestRename(collection.id) },
        {
          label: <span className="danger-ink">Delete…</span>,
          text: "Delete…",
          separator: true,
          onSelect: () => confirmDelete(collection),
        },
      ],
    });

  return (
    <div
      className={`panes collections${dropping ? " dropping" : ""}`}
      onDragOver={(event) => {
        if (!carriesFiles(event)) return;
        // A collection dropped here is imported, not added to the library as a spec.
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "copy";
        setDropping(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        setDropping(false);
        const file = event.dataTransfer.files?.[0];
        if (file) void file.text().then((text) => api.importText(text, file.name));
      }}
    >
      {dropping && (
        <div className="collections-drop" aria-hidden>
          <Import size={20} />
          <span>Drop to import a Postman collection or a Studio collection file</span>
        </div>
      )}
      <aside className="sidebar collections-side" aria-label="Collections">
        <div className="history-side-head">
          <h2>Collections</h2>
          <span className="meta">{collections.length}</span>
          <span className="spacer" />
          <button type="button" className="icon-btn tight" aria-label="New collection" title="New collection" onClick={() => api.requestNew()}>
            <Plus size={14} />
          </button>
        </div>
        <div className="collections-actions">
          {inTauri ? (
            <>
              <button type="button" className="btn" onClick={() => void api.openFromFile(true)} title="Open a collection file and keep it linked, e.g. in a git repository">
                <FolderOpen size={13} aria-hidden /> Open file…
              </button>
              <button type="button" className="btn" onClick={() => void api.openFromFile(false)} title="Import a Postman collection (v2.1), or a copy of a Studio collection file">
                <Import size={13} aria-hidden /> Import…
              </button>
            </>
          ) : (
            <button type="button" className="btn" onClick={() => importInput.current?.click()} title="Import a Postman collection (v2.1), or a Studio collection file">
              <Import size={13} aria-hidden /> Import…
            </button>
          )}
          <input
            ref={importInput}
            type="file"
            accept=".yaml,.yml,.json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void file.text().then((text) => api.importText(text, file.name));
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
              <div role="listitem" className="collection-row-wrap" key={collection.id}>
                <button
                  type="button"
                  className="row collection-row"
                  aria-current={selected?.id === collection.id ? "true" : undefined}
                  aria-selected={selected?.id === collection.id}
                  onClick={() => api.select(collection.id)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    rowMenu(collection, { x: event.clientX, y: event.clientY });
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "F2") {
                      event.preventDefault();
                      api.requestRename(collection.id);
                    } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                      event.preventDefault();
                      const rect = event.currentTarget.getBoundingClientRect();
                      rowMenu(collection, { x: rect.left + 24, y: rect.bottom });
                    }
                  }}
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
                <button
                  type="button"
                  className="icon-btn tight collection-row-menu"
                  aria-label={`Actions for ${collection.name}`}
                  aria-haspopup="menu"
                  tabIndex={-1}
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    rowMenu(collection, { x: rect.right - 160, y: rect.bottom + 4 });
                  }}
                >
                  <MoreHorizontal size={14} />
                </button>
              </div>
            );
          })}
          {api.loaded && !collections.length && (
            <div className="group-label">No collections yet</div>
          )}
        </div>
      </aside>

      <div className="workarea">
        {selected ? (
          <CollectionDetail
            key={selected.id}
            api={api}
            collection={selected}
            entries={entries}
            onGoLibrary={onGoLibrary}
            onDelete={() => confirmDelete(selected)}
          />
        ) : (
          <div className="empty">
            <h1>Collections</h1>
            <p>
              A collection runs steps in order, across your specs: create an order, get it, pay for it. Each step
              points at an operation, so its response is checked against that spec, and Studio tells you when a step no
              longer matches it.
            </p>
            <p>
              Right-click an operation and choose <strong>Add to collection</strong>, or add one from History. You can
              also import a Postman collection: use <strong>Import…</strong> or drop the file here.
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" className="btn primary" onClick={() => api.requestNew()}>
                New collection
              </button>
              <button type="button" className="btn" onClick={onGoLibrary}>
                Go to your APIs
              </button>
            </div>
          </div>
        )}
      </div>
      {api.imported && (
        <ImportSummaryDialog
          summary={api.imported.summary}
          environment={api.imported.environment}
          onDone={api.finishImport}
        />
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} label={menu.label} onClose={() => setMenu(null)} />}
      {confirming && (
        <ConfirmDialog
          title={confirming.title}
          confirm={confirming.confirm}
          danger={confirming.danger}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            setConfirming(null);
            confirming.run();
          }}
        >
          {confirming.body}
        </ConfirmDialog>
      )}
    </div>
  );
}

type View = "steps" | "chain" | "runs";

/** The operation a step points at, when it's in the library and still there. */
const opOf = (link: StepLink | undefined) => (link && (link.kind === "ok" || link.kind === "stale") ? link : null);

function CollectionDetail({
  api,
  collection,
  entries,
  onGoLibrary,
  onDelete,
}: {
  api: CollectionsApi;
  collection: Collection;
  entries: LibraryEntry[];
  onGoLibrary: () => void;
  onDelete: () => void;
}) {
  const run = api.runs[collection.id];
  const running = Boolean(run?.running);
  const results = useMemo(() => run?.results ?? [], [run?.results]);
  const summary = run && !running ? summariseRun(results) : null;
  const notice = api.notices[collection.id];
  const conflict = api.conflicts[collection.id];
  const index = Math.min(api.selectedStep, Math.max(0, collection.steps.length - 1));
  const step = collection.steps[index];
  const link: StepLink | undefined = api.links[index];
  const [view, setView] = useState<View>("steps");
  const [tab, setTab] = useState<StepTab>("request");
  const [menu, setMenu] = useState<Menu | null>(null);
  const [linking, setLinking] = useState<number | null>(null);
  const [linkDraft, setLinkDraft] = useState<LinkDraft | null>(null);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState(collection.name);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => setNameDraft(collection.name), [collection.name]);
  const runsPane = api.runLogs.pane(collection.id) === "runs";
  const pastRuns = api.runLogs.runsFor(collection.id);
  /** Steps and Chain are this view's own; Runs belongs to the run log, which can open it after a run. */
  const shown: View = runsPane ? "runs" : view;
  const show = (next: View) => {
    api.runLogs.setPane(collection.id, next === "runs" ? "runs" : "steps");
    if (next !== "runs") setView(next);
  };

  // After a run, show the first failing step's response, since that's the question.
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running && shown === "steps") {
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

  // ── the chain: what each step offers, and every link checked ──────────────

  const outputs = useMemo(() => {
    const map = new Map<string, StepOutput>();
    for (const result of results) if (result.output) map.set(result.key, result.output);
    return map;
  }, [results]);

  /** Each step's pickable values: from its last response, or its declared one. */
  const stepFields: StepFields[] = useMemo(
    () =>
      collection.steps.map((s, i) => {
        const base = {
          key: s.key,
          index: i,
          title: stepTitle(collection, i),
          method: (s.operation?.method ?? s.request?.method ?? "GET").toUpperCase(),
          path: s.operation?.path ?? s.request?.url ?? "",
        };
        const output = outputs.get(s.key);
        if (output) return { ...base, fields: fieldsFromOutput(s.key, output), from: "response" as const };
        const l = opOf(api.links[i]);
        const success = l?.op.responses.find((r) => /^2/.test(r.status) && r.schema);
        if (l && success) return { ...base, fields: fieldsFromSchema(s.key, l.spec.doc, success.schema), from: "schema" as const };
        return { ...base, fields: [], from: "none" as const };
      }),
    [collection, outputs, api.links],
  );

  const facts = useCallback(
    (key: string): SourceFacts | undefined => {
      const info = stepFields.find((s) => s.key === key);
      if (!info) return undefined;
      const output = outputs.get(key);
      if (output) return { output };
      return info.from === "schema" ? { schemaFields: info.fields.map((f) => f.path) } : {};
    },
    [stepFields, outputs],
  );

  /** What the latest run recorded for each step's references (already redacted by the run log). */
  const latestRun = pastRuns[0];
  const recorded = useMemo(() => {
    if (!latestRun) return null;
    const byKey = new Map<string, ResolvedLink[]>();
    for (const event of latestRun.events) {
      if (event.type !== "references_resolved") continue;
      byKey.set(event.key, [...(byKey.get(event.key) ?? []), ...event.links]);
    }
    return byKey;
  }, [latestRun]);
  const views: LinkView[] = useMemo(
    () => analyseChain(collection, facts, outputs, recorded ? (key) => recorded.get(key) ?? [] : undefined),
    [collection, facts, outputs, recorded],
  );
  const brokenCount = views.filter((v) => v.check.state === "broken").length;

  const targetsFor = useCallback(
    (i: number): StepTargets => {
      const s = collection.steps[i];
      const l = opOf(api.links[i]);
      const op = l?.op ?? null;
      const doc = l?.spec.doc ?? null;
      const schema = op?.requestBody?.schema;
      const takesBody = op
        ? Boolean(op.requestBody) && bodyModeFor(op.requestBody!.contentType) === "text"
        : typeof s?.body === "string" || Boolean(s?.request);
      return {
        fields: s ? linkableFields(s, op, doc) : [],
        bodyProblem: s ? bodyProblem(s) : null,
        takesBody,
        bareFor: (path) => {
          const type = doc && schema ? schemaTypeAt(doc, schema, path) : undefined;
          return type !== undefined && type !== "string";
        },
      };
    },
    [collection.steps, api.links],
  );

  /** What a body field goes back to when its link is removed: the spec's example for it. */
  const replacementFor = useCallback(
    (target: ChainLink): unknown => {
      if (target.target.in !== "body") return null;
      const l = opOf(api.links[target.targetIndex]);
      const body = l?.op.requestBody;
      if (!l || !body) return null;
      const example = body.media ? mediaExample(l.spec.doc, body.media) : exampleFor(l.spec.doc, body.schema, "body");
      return bodyExampleAt(example, target.target.path) ?? null;
    },
    [api.links],
  );

  const applyChain = (change: (c: Collection) => Collection): string | null => {
    const problem = api.editChain(collection.id, change);
    setLinkError(problem);
    return problem;
  };

  const openEdit = (v: LinkView) =>
    setLinkDraft({ targetIndex: v.targetIndex, target: v.target, source: v.source, editing: v });
  const removeView = (v: LinkView) => applyChain((c) => removeLink(c, v, replacementFor(v)));

  // ── moving and removing steps, with a warning when it breaks links ─────────

  const describeLinks = (links: ChainLink[]) => (
    <ul className="confirm-list">
      {links.map((l, i) => {
        const source = collection.steps.find((s) => s.key === l.source.step);
        return (
          <li key={i}>
            <strong>{stepLabel(collection.steps[l.targetIndex])}</strong> <span className="mono">{describeLinkTarget(l.target)}</span>{" "}
            takes a value from <strong>{stepLabel(source, l.source.step)}</strong>
          </li>
        );
      })}
    </ul>
  );

  const requestMove = (from: number, to: number) => {
    if (to < 0 || to >= collection.steps.length || from === to) return;
    const breaks = linksBrokenByMove(collection, from, to);
    if (!breaks.length) {
      api.moveStep(collection.id, from, to);
      return;
    }
    setConfirming({
      title: "Moving this step breaks links",
      body: (
        <>
          <p>
            After the move, {breaks.length === 1 ? "this link takes its value" : "these links take their values"} from a step
            that runs later, so {breaks.length === 1 ? "it" : "they"} can&apos;t work:
          </p>
          {describeLinks(breaks)}
          <p className="field-meta">You can move it back, or change the links in the Chain view.</p>
        </>
      ),
      confirm: "Move anyway",
      run: () => api.moveStep(collection.id, from, to),
    });
  };

  const requestRemove = (i: number) => {
    const target = collection.steps[i];
    if (!target) return;
    const dependents = dependentsOf(collection, i);
    if (!dependents.length) {
      api.removeStep(collection.id, i);
      return;
    }
    const names = [...new Set(dependents.map((d) => stepLabel(collection.steps[d.targetIndex])))];
    setConfirming({
      title: `Remove “${stepLabel(target)}”?`,
      body: (
        <>
          <p>
            {names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`}{" "}
            {names.length === 1 ? "takes values" : "take values"} from this step. Those links will break:
          </p>
          {describeLinks(dependents)}
        </>
      ),
      confirm: "Remove step",
      danger: true,
      run: () => api.removeStep(collection.id, i),
    });
  };

  const fixFor = (v: LinkView): { label: string; run: () => void } | null => {
    if (v.check.state !== "broken") return null;
    const fix = v.check.fix;
    if (fix.kind === "move") {
      return {
        label: `Move ${stepLabel(collection.steps[fix.from])} before ${stepLabel(collection.steps[fix.to])}`,
        run: () => requestMove(fix.from, fix.to),
      };
    }
    return { label: "Choose another value…", run: () => openEdit(v) };
  };

  const stepMenu = (i: number): MenuItem[] => {
    const s = collection.steps[i];
    const l = api.links[i];
    const linked = l?.kind === "ok" || l?.kind === "stale";
    return [
      {
        label: s?.api && linked ? "Change operation…" : "Link to an operation…",
        hint: linked ? undefined : "not linked",
        onSelect: () => setLinking(i),
      },
      ...(i > 0 ? [{ label: "Take a value from an earlier step…", onSelect: () => setLinkDraft({ targetIndex: i }) }] : []),
      { label: "Duplicate", onSelect: () => api.duplicateStep(collection.id, i) },
      { label: "Move up", hint: "Alt+↑", disabled: i === 0, separator: true, onSelect: () => requestMove(i, i - 1) },
      { label: "Move down", hint: "Alt+↓", disabled: i === collection.steps.length - 1, onSelect: () => requestMove(i, i + 1) },
      {
        label: <span className="danger-ink">Remove step</span>,
        text: "Remove step",
        hint: "Delete",
        separator: true,
        onSelect: () => requestRemove(i),
      },
    ];
  };

  // ── the step editor's view of its links ───────────────────────────────────

  const chain: StepChain = {
    collection,
    canLink: index > 0,
    linkFor: (target: LinkTarget, reference: string, whole: boolean) => {
      const known = views.find((v) => v.targetIndex === index && sameTarget(v.target, target) && v.reference === reference);
      if (known) return known;
      // Just typed and not saved into the step yet: check it the same way.
      const found = findRefs(reference)[0];
      const source = { step: found?.step ?? "", path: found?.path ?? [] };
      const base: ChainLink = { targetIndex: index, targetStep: step?.key ?? "", target, source, reference, whole };
      const value = linkValue(base, outputs);
      return {
        ...base,
        id: `live|${reference}`,
        sourceIndex: collection.steps.findIndex((s) => s.key === source.step),
        check: checkLink(collection, base, facts),
        ...(value !== undefined ? { value } : {}),
      };
    },
    bodyLinks: views.filter((v) => v.targetIndex === index && (v.target.in === "body" || (v.target.in === "text" && v.target.where === "body"))),
    bodyProblem: step ? bodyProblem(step) : null,
    onAdd: (target) => setLinkDraft({ targetIndex: index, target }),
    onEdit: openEdit,
    onRemove: removeView,
    fixFor,
  };

  const onChange = useCallback(
    (change: Parameters<CollectionsApi["updateStep"]>[2]) => api.updateStep(collection.id, index, change),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api.updateStep, collection.id, index],
  );

  const copy = (reference: string) => {
    void navigator.clipboard?.writeText(reference).catch(() => {});
    setCopied(reference);
    window.setTimeout(() => setCopied((current) => (current === reference ? null : current)), 3500);
  };

  const moreItems: MenuItem[] = [
    { label: "Rename…", onSelect: () => api.requestRename(collection.id) },
    ...(inTauri
      ? [
          {
            label: collection.file ? "Save to another file…" : "Save to a folder…",
            hint: "stays linked",
            separator: true,
            onSelect: () => void api.saveToFolder(collection.id),
          },
        ]
      : []),
    { label: "Export a copy…", separator: !inTauri, onSelect: () => void api.exportCollection(collection.id) },
    ...(collection.file ? [{ label: "Keep in Studio only", onSelect: () => api.stopLinking(collection.id) }] : []),
    {
      label: <span className="danger-ink">Delete collection…</span>,
      text: "Delete collection…",
      separator: true,
      onSelect: onDelete,
    },
  ];

  const removed = api.removed?.collectionId === collection.id ? api.removed : null;

  return (
    <div className="collection">
      <header className="collection-head">
        <div className="collection-title-row">
          <input
            className="collection-title"
            aria-label="Collection name"
            title="Click to rename"
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
              if (event.key === "Escape") {
                setNameDraft(collection.name);
                requestAnimationFrame(() => (event.target as HTMLInputElement).blur());
              }
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
          <TabList<View>
            className="segmented collection-views"
            tabClassName="segment"
            label="Collection views"
            tabs={[
              { id: "steps", label: "Steps", title: "Each step's request and response" },
              {
                id: "chain",
                label: (
                  <>
                    Chain
                    {views.length > 0 && <span className="segment-count">{views.length}</span>}
                    {brokenCount > 0 && <span className="segment-alert" aria-label={`${brokenCount} broken`} />}
                  </>
                ),
                title: "The values passed between steps",
              },
              {
                id: "runs",
                label: (
                  <>
                    Runs
                    {pastRuns.length > 0 && <span className="segment-count">{pastRuns.length}</span>}
                  </>
                ),
                title: "What each run did, step by step",
              },
            ]}
            selected={shown}
            onSelect={show}
          />
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
      {removed && (
        <div className="verdict none collection-banner" role="status">
          <span className="glyph">i</span>
          <span>Removed “{removed.label}”.</span>
          <span className="spacer" />
          <button type="button" className="btn" onClick={api.undoRemove}>
            Undo
          </button>
          <button type="button" className="btn ghost" onClick={api.dismissRemoved}>
            Dismiss
          </button>
        </div>
      )}
      {linkError && (
        <div className="verdict warn collection-banner" role="alert">
          <AlertTriangle size={14} aria-hidden className="glyph" />
          <span>{linkError}</span>
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={() => setLinkError(null)}>
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
            Copied <code>{copied}</code>.
          </span>
        </div>
      )}

      {shown === "runs" ? (
        <div className="collection-body">
          <RunLogView
            runs={pastRuns}
            selectedId={api.runLogs.selectedRun(collection.id)}
            onSelect={(runId) => api.runLogs.selectRun(collection.id, runId)}
            onClear={() => api.runLogs.clear(collection.id)}
            onExport={api.runLogs.exportRun}
          />
        </div>
      ) : collection.steps.length && shown === "chain" ? (
        <div className="collection-body chain-body">
          <ChainView
            collection={collection}
            views={views}
            steps={stepFields}
            results={results}
            runningIndex={runningIndex}
            onAdd={setLinkDraft}
            onEdit={openEdit}
            onRemove={removeView}
            fixFor={fixFor}
            onOpenStep={(i) => {
              api.setSelectedStep(i);
              setTab("request");
              show("steps");
            }}
          />
        </div>
      ) : collection.steps.length ? (
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
              onMove={requestMove}
              onMenu={(i, at) => setMenu({ ...at, items: stepMenu(i), label: `Actions for step ${i + 1}` })}
              onRemove={requestRemove}
            />
            <div className="field-meta step-list-hint">
              Drag to reorder, or {`Alt+↑ / Alt+↓`}. Right-click a step for more. Right-click an operation in an API to add a step.
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
              chain={chain}
              result={results.find((r) => r.key === step.key)}
              running={running && runningIndex === index}
              tab={tab}
              onTab={setTab}
              onChange={onChange}
              onRenameKey={(to) => api.renameStepKey(collection.id, step.key, to)}
              onMenu={(rect) => setMenu({ x: rect.right - 220, y: rect.bottom + 4, items: stepMenu(index), label: `Actions for step ${index + 1}` })}
              onLink={() => setLinking(index)}
              revision={api.revision}
              onPickFromResponse={(reference, rect) => {
                const later = collection.steps.map((_, i) => i).filter((i) => i > index);
                const found = findRefs(reference)[0];
                setMenu({
                  x: rect.left,
                  y: rect.bottom + 4,
                  label: "Use this value",
                  items: [
                    {
                      label: "Use in a later step",
                      text: "Use in a later step",
                      disabled: !later.length || !found,
                      submenu: later.map((i) => ({
                        label: `${i + 1}. ${stepTitle(collection, i)}`,
                        onSelect: () =>
                          found && setLinkDraft({ targetIndex: i, source: { step: found.step, path: found.path } }),
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
      {linking !== null && collection.steps[linking] && (
        <LinkOperationDialog
          entries={entries}
          initialEntryId={(() => {
            const l = api.links[linking];
            return l && "entry" in l && l.entry ? l.entry.id : null;
          })()}
          hint={(() => {
            const s = collection.steps[linking];
            return s.operation
              ? `${s.operation.operationId ?? ""} ${s.operation.method} ${s.operation.path}`.trim()
              : `${s.request?.method ?? ""} ${s.request?.url ?? ""}`;
          })()}
          title={opOf(api.links[linking]) ? "Change operation" : "Link to an operation"}
          loadSpec={api.specForEntry}
          onPick={(entry, op) => {
            api.relinkStep(collection.id, linking, entry, op);
            setLinking(null);
          }}
          onClose={() => setLinking(null)}
        />
      )}
      {linkDraft && (
        <LinkDialog
          collection={collection}
          steps={stepFields}
          targetsFor={targetsFor}
          initial={linkDraft}
          onClose={() => setLinkDraft(null)}
          onSave={(next, editing) =>
            api.editChain(collection.id, (c) =>
              editing
                ? editLink(c, editing, next, replacementFor(editing))
                : setLink(c, next.targetIndex, next.target, next.source, { bare: next.bare }),
            )
          }
        />
      )}
      {confirming && (
        <ConfirmDialog
          title={confirming.title}
          confirm={confirming.confirm}
          danger={confirming.danger}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            setConfirming(null);
            confirming.run();
          }}
        >
          {confirming.body}
        </ConfirmDialog>
      )}
    </div>
  );
}
