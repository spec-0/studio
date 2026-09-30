import { useRef, useState } from "react";
import { AlertTriangle, GripVertical, Link2Off, Unlink } from "lucide-react";
import type { Collection } from "../../lib/collection";
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
 * selected row; the new position is announced. Each row carries its marker: a
 * warning when the spec changed under it, a cross when its operation is gone,
 * and the last run's result.
 */
export function StepList({ collection, links, results, runningIndex, selected, onSelect, onMove }: Props) {
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
        aria-label="Steps, in the order they run. Alt+Up and Alt+Down move the selected step."
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
                onKeyDown={(event) => {
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
                  <span className="step-marker" title="Not linked to an operation, so its response isn't checked.">
                    <Unlink size={13} aria-hidden />
                    unlinked
                  </span>
                )}
                <span id={`step-state-${index}`} className="sr-only">
                  {link?.kind === "stale"
                    ? `Changed in the spec: ${link.reasons.join(" ")}`
                    : link?.kind === "unresolved"
                      ? link.reason
                      : ""}
                  {result ? ` Last run: ${result.verdict === "pass" ? "passed" : result.verdict === "fail" ? "failed" : "not run"}.` : ""}
                </span>
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
