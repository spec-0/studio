import { useRef, useState } from "react";
import { AlertTriangle, GripVertical, Link2Off, MoreHorizontal, Unlink } from "lucide-react";
import { describeExpected, expectedStatusOf, type Collection } from "../../lib/collection";
import { describeTarget, type StepLink } from "../../lib/collectionLink";
import type { StepResult } from "../../lib/collectionRun";

interface Props {
  collection: Collection;
  links: StepLink[];
  results: StepResult[];
  /** The step running now, while a run is in progress. */
  runningIndex: number | null;
  selected: number;
  onSelect: (index: number) => void;
  onMove: (from: number, to: number) => void;
  /** Open the step's menu at a point: right-click, the row's ⋯ button, or the context-menu key. */
  onMenu: (index: number, at: { x: number; y: number }) => void;
  /** Delete or Backspace on the selected row. */
  onRemove: (index: number) => void;
}

/** What to call a step in the list and in messages. */
export function stepTitle(collection: Collection, index: number): string {
  const step = collection.steps[index];
  return step?.name || step?.key || `Step ${index + 1}`;
}

/**
 * The steps, in the order they run.
 *
 * Reordered by dragging a row, or from the keyboard with Alt+↑ and Alt+↓ on the
 * selected row; the new position is announced. Each row has a menu (right-click,
 * the ⋯ button on hover, or Shift+F10), and Delete removes the selected step
 * while the list has focus. Each row carries its marker: a
 * warning when the spec changed under it, a cross when its operation is gone,
 * and the last run's result.
 */
export function StepList({ collection, links, results, runningIndex, selected, onSelect, onMove, onMenu, onRemove }: Props) {
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [announce, setAnnounce] = useState("");
  const list = useRef<HTMLOListElement>(null);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= collection.steps.length || from === to) return;
    onMove(from, to);
    setAnnounce(`Moved ${stepTitle(collection, from)} to position ${to + 1} of ${collection.steps.length}.`);
    // Keep focus on the row that moved.
    requestAnimationFrame(() => list.current?.querySelectorAll<HTMLElement>(".step-row")[to]?.focus());
  };

  return (
    <>
      <ol
        ref={list}
        className="step-list"
        aria-label="Steps, in the order they run. Alt+Up and Alt+Down move the selected step, Delete removes it, Shift+F10 opens its menu."
      >
        {collection.steps.map((step, index) => {
          const link = links[index];
          const result = results.find((r) => r.key === step.key);
          const spec = link && "spec" in link ? (link.spec ?? null) : null;
          const apiTitle =
            link && "entry" in link && link.entry
              ? link.entry.title
              : step.api
                ? (collection.apis[step.api]?.title ?? step.api)
                : "Not linked to a spec";
          const method = (step.operation?.method ?? step.request?.method ?? "GET").toUpperCase();
          const path = step.operation?.path ?? step.request?.url ?? "";
          const expected = expectedStatusOf(step);
          const state =
            runningIndex === index
              ? "running"
              : result?.verdict ?? "idle";
          return (
            <li
              key={step.key}
              className={`step-row-wrap${dropAt === index && dragFrom !== null && dragFrom !== index ? (dragFrom < index ? " drop-after" : " drop-before") : ""}`}
              onDragOver={(event) => {
                if (dragFrom === null) return;
                event.preventDefault();
                event.stopPropagation();
                setDropAt(index);
              }}
              onDrop={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (dragFrom !== null) move(dragFrom, index);
                setDragFrom(null);
                setDropAt(null);
              }}
            >
              <button
                type="button"
                className="step-row"
                aria-current={selected === index ? "step" : undefined}
                aria-describedby={`step-state-${index}`}
                draggable
                onDragStart={(event) => {
                  setDragFrom(index);
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", step.key);
                  event.stopPropagation();
                }}
                onDragEnd={() => {
                  setDragFrom(null);
                  setDropAt(null);
                }}
                onClick={() => onSelect(index)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  onSelect(index);
                  onMenu(index, { x: event.clientX, y: event.clientY });
                }}
                onKeyDown={(event) => {
                  // The row has focus, so this is never someone typing in a field.
                  if ((event.key === "Delete" || event.key === "Backspace") && !event.altKey && !event.metaKey && !event.ctrlKey) {
                    event.preventDefault();
                    onRemove(index);
                    return;
                  }
                  if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                    event.preventDefault();
                    const rect = event.currentTarget.getBoundingClientRect();
                    onMenu(index, { x: rect.left + 24, y: rect.bottom });
                    return;
                  }
                  if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
                    event.preventDefault();
                    move(index, index + (event.key === "ArrowUp" ? -1 : 1));
                  } else if (!event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
                    event.preventDefault();
                    const next = index + (event.key === "ArrowUp" ? -1 : 1);
                    if (next >= 0 && next < collection.steps.length) {
                      onSelect(next);
                      list.current?.querySelectorAll<HTMLElement>(".step-row")[next]?.focus();
                    }
                  }
                }}
              >
                <GripVertical size={13} className="step-grip" aria-hidden />
                <span className="step-index">{index + 1}</span>
                <span className={`run-dot ${state}`} aria-hidden />
                <span className="step-main">
                  <span className="step-line">
                    <span className={`method ${method.toLowerCase()}`}>{method}</span>
                    <span className="path">{path}</span>
                    {expected && (
                      <span className="step-expect" title={`This step passes when the server answers ${describeExpected(expected)}.`}>
                        expects {describeExpected(expected)}
                      </span>
                    )}
                  </span>
                  <span className="summary">
                    {step.name ? `${step.name} · ` : ""}
                    {apiTitle}
                    {spec || step.target ? ` · ${describeTarget(step.target, spec)}` : ""}
                  </span>
                </span>
                {link?.kind === "stale" && (
                  <span className="step-marker warn" title={link.reasons.join("\n")}>
                    <AlertTriangle size={13} aria-hidden />
                    changed
                  </span>
                )}
                {link?.kind === "unresolved" && (
                  <span className="step-marker danger" title={link.reason}>
                    <Link2Off size={13} aria-hidden />
                    missing
                  </span>
                )}
                {link?.kind === "unlinked" && (
                  <span className="step-marker" title="Not linked to an operation in any spec, so its response isn't checked.">
                    <Unlink size={13} aria-hidden />
                    not in any spec
                  </span>
                )}
                <span id={`step-state-${index}`} className="sr-only">
                  {link?.kind === "stale"
                    ? `Changed in the spec: ${link.reasons.join(" ")}`
                    : link?.kind === "unresolved"
                      ? link.reason
                      : ""}
                  {expected ? ` Expects ${describeExpected(expected)}.` : ""}
                  {result ? ` Last run: ${result.verdict === "pass" ? "passed" : result.verdict === "fail" ? "failed" : "not run"}.` : ""}
                </span>
              </button>
              <button
                type="button"
                className="icon-btn tight step-row-menu"
                aria-label={`Actions for step ${index + 1}, ${stepTitle(collection, index)}`}
                aria-haspopup="menu"
                tabIndex={-1}
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  onSelect(index);
                  onMenu(index, { x: rect.right - 180, y: rect.bottom + 4 });
                }}
              >
                <MoreHorizontal size={14} />
              </button>
            </li>
          );
        })}
      </ol>
      <div className="sr-only" role="status" aria-live="polite">
        {announce}
      </div>
    </>
  );
}
