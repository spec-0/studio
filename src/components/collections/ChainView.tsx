import { Fragment, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, CircleHelp, Link2, Plus, X } from "lucide-react";
import { describeLinkTarget, describeSourcePath, type LinkView } from "../../lib/chainLinks";
import type { Collection } from "../../lib/collection";
import type { StepResult } from "../../lib/collectionRun";
import type { StepFields, LinkDraft } from "./LinkDialog";
import { shownValue, SourceLabel } from "./LinkChip";

interface Props {
  collection: Collection;
  views: LinkView[];
  steps: StepFields[];
  results: StepResult[];
  runningIndex: number | null;
  onAdd: (draft: LinkDraft) => void;
  onEdit: (view: LinkView) => void;
  onRemove: (view: LinkView) => void;
  fixFor: (view: LinkView) => { label: string; run: () => void } | null;
  onOpenStep: (index: number) => void;
}

interface Line {
  id: string;
  from: number;
  to: number;
  state: LinkView["check"]["state"];
  lane: number;
}

const LANE = 12;
const EDGE = 14;

/**
 * The chain: every step in the order it runs, what each one gives to later
 * steps and what it takes from earlier ones, with a line from each value's
 * source to the field it fills.
 *
 * The steps run top to bottom, so the picture is a column rather than a
 * free-form graph: lines run down a gutter on the left, nested so they never
 * cross a card, and a line that runs upward is a link whose source now runs
 * too late. Every line is also a row of text with its own buttons, and the
 * table underneath lists them all again, so nothing here depends on seeing the
 * lines.
 */
export function ChainView({ collection, views, steps, results, runningIndex, onAdd, onEdit, onRemove, fixFor, onOpenStep }: Props) {
  const graph = useRef<HTMLDivElement>(null);
  const [ports, setPorts] = useState<Record<string, number>>({});
  const [height, setHeight] = useState(0);
  const [hot, setHot] = useState<string | null>(null);

  /** What each step gives to later steps: its response fields that links use. */
  const gives = useMemo(() => {
    const out = new Map<number, Array<{ label: string; ids: string[]; value?: string; preview?: string }>>();
    for (const view of views) {
      if (view.sourceIndex < 0) continue;
      const label = describeSourcePath(view.source.path);
      const rows = out.get(view.sourceIndex) ?? [];
      const row = rows.find((r) => r.label === label);
      if (row) row.ids.push(view.id);
      else {
        const preview = steps[view.sourceIndex]?.fields.find((f) => describeSourcePath(f.path) === label)?.preview;
        rows.push({ label, ids: [view.id], value: view.value, preview });
      }
      out.set(view.sourceIndex, rows);
    }
    return out;
  }, [views, steps]);

  const lines: Line[] = useMemo(() => {
    const drawn = views
      .filter((view) => view.sourceIndex >= 0)
      .map((view) => {
        const from = ports[`g:${view.sourceIndex}:${describeSourcePath(view.source.path)}`];
        const to = ports[`t:${view.id}`];
        return from === undefined || to === undefined ? null : { id: view.id, from, to, state: view.check.state, lane: 0 };
      })
      .filter((line): line is Line => Boolean(line))
      .sort((a, b) => Math.abs(a.to - a.from) - Math.abs(b.to - b.from));
    // Short links take the lanes nearest the cards, so longer ones wrap around them.
    const taken: Array<Array<[number, number]>> = [];
    for (const line of drawn) {
      const span: [number, number] = [Math.min(line.from, line.to) - 3, Math.max(line.from, line.to) + 3];
      let lane = 0;
      while ((taken[lane] ?? []).some(([a, b]) => span[0] < b && a < span[1])) lane += 1;
      (taken[lane] ??= []).push(span);
      line.lane = lane;
    }
    return drawn;
  }, [views, ports]);

  const lanes = Math.max(1, ...lines.map((l) => l.lane + 1));
  const gutter = EDGE + lanes * LANE + 6;

  const measure = useCallback(() => {
    const root = graph.current;
    if (!root) return;
    const top = root.getBoundingClientRect().top;
    const next: Record<string, number> = {};
    for (const el of root.querySelectorAll<HTMLElement>("[data-port]")) {
      const rect = el.getBoundingClientRect();
      next[el.dataset.port!] = Math.round(rect.top - top + rect.height / 2);
    }
    setPorts((prev) => {
      const same = Object.keys(prev).length === Object.keys(next).length && Object.entries(next).every(([k, v]) => prev[k] === v);
      return same ? prev : next;
    });
    setHeight(root.scrollHeight);
  }, []);

  useLayoutEffect(() => {
    measure();
  });
  useLayoutEffect(() => {
    const root = graph.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(root);
    return () => observer.disconnect();
  }, [measure]);

  const broken = views.filter((v) => v.check.state === "broken");
  const hover = (id: string | null) => () => setHot(id);

  if (collection.steps.length < 2) {
    return (
      <div className="chain-view">
        <div className="empty chain-empty">
          <p>
            A link passes a value from one step&apos;s response into a later step, like the id of an order you just
            created. Add a second step to this collection to link them.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="chain-view">
      <div className="chain-bar">
        <p className="chain-lead">
          {views.length
            ? `${views.length} value${views.length === 1 ? "" : "s"} passed between steps. Each line runs from a field in a step's response to the field it fills in a later step.`
            : "No values are passed between steps yet. A later step can use a value from an earlier step's response, like the id of an order it created."}
        </p>
        <button type="button" className="btn primary" onClick={() => onAdd({ targetIndex: collection.steps.length > 1 ? 1 : 0 })}>
          <Plus size={13} aria-hidden /> Add link
        </button>
      </div>

      {broken.length > 0 && (
        <div className="verdict warn chain-alert" role="status">
          <AlertTriangle size={14} aria-hidden className="glyph" />
          <span>
            {broken.length} link{broken.length === 1 ? " can't" : "s can't"} work as the collection is now. Each one says
            why, with a way to fix it.
          </span>
        </div>
      )}

      <div className="chain-graph" ref={graph} style={{ ["--chain-gutter" as string]: `${gutter}px` }}>
        <svg className="chain-lines" width={gutter} height={height} aria-hidden focusable="false">
          {lines.map((line) => {
            const x = gutter - EDGE - line.lane * LANE - 6;
            const end = gutter - 2;
            const down = line.to > line.from;
            const r = Math.min(6, Math.abs(line.to - line.from) / 2);
            const d = [
              `M ${end} ${line.from}`,
              `H ${x + r}`,
              `Q ${x} ${line.from} ${x} ${line.from + (down ? r : -r)}`,
              `V ${line.to + (down ? -r : r)}`,
              `Q ${x} ${line.to} ${x + r} ${line.to}`,
              `H ${end - 5}`,
            ].join(" ");
            const cls = `chain-line ${line.state}${hot === line.id ? " hot" : ""}${hot && hot !== line.id ? " dim" : ""}`;
            return (
              <g key={line.id} className={cls} onMouseEnter={hover(line.id)} onMouseLeave={hover(null)}>
                <path d={d} className="chain-hit" />
                <path d={d} className="chain-stroke" />
                <circle cx={end - 1} cy={line.from} r={3} className="chain-dot" />
                <path d={`M ${end - 7} ${line.to - 4} L ${end} ${line.to} L ${end - 7} ${line.to + 4} Z`} className="chain-head" />
              </g>
            );
          })}
        </svg>

        <ol className="chain-steps">
          {collection.steps.map((step, index) => {
            const info = steps[index];
            const result = results.find((r) => r.key === step.key);
            const state = runningIndex === index ? "running" : (result?.verdict ?? "idle");
            const takes = views.filter((v) => v.targetIndex === index);
            const giving = gives.get(index) ?? [];
            return (
              <li key={step.key} className="chain-step">
                <div className="chain-step-head">
                  <span className="chain-step-no">{index + 1}</span>
                  <span className={`run-dot ${state}`} aria-label={result ? `Last run: ${result.verdict === "pass" ? "passed" : result.verdict === "fail" ? "failed" : "not run"}` : undefined} />
                  <span className={`method ${info?.method.toLowerCase() ?? "get"}`}>{info?.method}</span>
                  <span className="chain-step-title">
                    <strong>{step.name || step.key}</strong>
                    <span className="mono chain-step-path">{info?.path}</span>
                  </span>
                  <span className="spacer" />
                  <button type="button" className="btn ghost" onClick={() => onOpenStep(index)}>
                    Open step
                  </button>
                </div>

                {giving.length > 0 && (
                  <div className="chain-rows">
                    <div className="chain-rows-label">Gives</div>
                    {giving.map((row) => {
                      const value = shownValue(row.value);
                      const lit = Boolean(hot && row.ids.includes(hot));
                      return (
                        <div
                          key={row.label}
                          className={`chain-row give${lit ? " hot" : ""}`}
                          data-port={`g:${index}:${row.label}`}
                          onMouseEnter={hover(row.ids[0])}
                          onMouseLeave={hover(null)}
                        >
                          <span className="mono chain-field">{row.label}</span>
                          {value ? (
                            <span className="mono chain-value" title={value.full}>
                              {value.short}
                            </span>
                          ) : row.preview ? (
                            <span className="field-meta">{row.preview}</span>
                          ) : null}
                          <span className="field-meta chain-used">
                            to {describeUsers(collection, views, row.ids)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}

                {takes.length > 0 && (
                  <div className="chain-rows">
                    <div className="chain-rows-label">Takes</div>
                    {takes.map((view) => {
                      // A broken link passes nothing now, whatever it passed before.
                      const value = view.check.state === "broken" ? null : shownValue(view.value);
                      const fix = view.check.state === "broken" ? fixFor(view) : null;
                      const notRun = result?.verdict === "not_run";
                      return (
                        <div
                          key={view.id}
                          className={`chain-row take ${view.check.state}${hot === view.id ? " hot" : ""}`}
                          data-port={`t:${view.id}`}
                          onMouseEnter={hover(view.id)}
                          onMouseLeave={hover(null)}
                          onFocus={hover(view.id)}
                          onBlur={hover(null)}
                        >
                          <div className="chain-take-line">
                            <span className="mono chain-field">{describeLinkTarget(view.target)}</span>
                            <ArrowLeft size={12} className="chain-take-arrow" aria-label="takes its value from" />
                            <SourceLabel collection={collection} view={view} />
                            {view.check.state === "unchecked" && (
                              <span className="chain-unchecked" title={view.check.reason} aria-label={`Not checked yet: ${view.check.reason}`}>
                                <CircleHelp size={12} aria-hidden />
                              </span>
                            )}
                            {value && !notRun && (
                              <span className="chain-value-slot">
                                <span className="mono chain-value" title={`Passed on the last run: ${value.full}`}>
                                  {value.short}
                                </span>
                              </span>
                            )}
                            {notRun && <span className="field-meta">not sent: this step didn&apos;t run</span>}
                            <span className="spacer" />
                            <button type="button" className="btn ghost" onClick={() => onEdit(view)}>
                              Change
                            </button>
                            <button
                              type="button"
                              className="icon-btn tight"
                              aria-label={`Remove the link into ${describeLinkTarget(view.target)}`}
                              title="Remove link"
                              onClick={() => onRemove(view)}
                            >
                              <X size={13} />
                            </button>
                          </div>
                          {view.check.state === "broken" && (
                            <div className="chain-problem" role="note">
                              <AlertTriangle size={12} aria-hidden />
                              <span>{view.check.reason}</span>
                              {fix && (
                                <button type="button" className="btn" onClick={fix.run}>
                                  {fix.label}
                                </button>
                              )}
                            </div>
                          )}
                          {!view.whole && (
                            <div className="field-meta chain-partial">Part of a longer value in this field.</div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {index > 0 && (
                  <button type="button" className="chain-add" onClick={() => onAdd({ targetIndex: index })}>
                    <Link2 size={12} aria-hidden /> Take a value from an earlier step
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      </div>

      {views.length > 0 && (
        <section className="chain-list" aria-labelledby="chain-list-title">
          <h3 id="chain-list-title">All links</h3>
          <table className="fields chain-table">
            <thead>
              <tr>
                <th>Fills</th>
                <th>With</th>
                <th>Last value</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {views.map((view) => {
                const target = collection.steps[view.targetIndex];
                const value = view.check.state === "broken" ? null : shownValue(view.value, 24);
                return (
                  <Fragment key={view.id}>
                    <tr
                      className={`${view.check.state}${hot === view.id ? " hot" : ""}`}
                      onMouseEnter={hover(view.id)}
                      onMouseLeave={hover(null)}
                    >
                      <td>
                        <span className="link-step-no">{view.targetIndex + 1}</span> {target?.name || target?.key}{" "}
                        <span className="mono">{describeLinkTarget(view.target)}</span>
                      </td>
                      <td>
                        <SourceLabel collection={collection} view={view} />
                        {view.check.state === "broken" && (
                          <div className="danger-ink field-meta">
                            <AlertTriangle size={11} aria-hidden /> {view.check.reason}
                          </div>
                        )}
                        {view.check.state === "unchecked" && <div className="field-meta">Not checked yet: {view.check.reason}</div>}
                      </td>
                      <td className="mono" title={value?.full}>
                        {value?.short ?? <span className="field-meta">{view.check.state === "broken" ? "—" : view.value === undefined ? "no run yet" : ""}</span>}
                      </td>
                      <td className="chain-table-actions">
                        <button type="button" className="btn ghost" onClick={() => onEdit(view)}>
                          Change
                        </button>
                        <button type="button" className="btn ghost" onClick={() => onRemove(view)}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

/** "Get order, Pay": the steps a response field is passed to. */
function describeUsers(collection: Collection, views: LinkView[], ids: string[]): string {
  const names = [
    ...new Set(
      ids
        .map((id) => views.find((v) => v.id === id))
        .filter((v): v is LinkView => Boolean(v))
        .map((v) => {
          const step = collection.steps[v.targetIndex];
          return `${v.targetIndex + 1}. ${step?.name || step?.key}`;
        }),
    ),
  ];
  return names.join(", ");
}
