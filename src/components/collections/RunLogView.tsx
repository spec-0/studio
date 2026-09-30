import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Copy, Download, Trash2 } from "lucide-react";
import { absoluteTime, relativeTime } from "../../lib/history";
import {
  describeCause,
  describeCounts,
  describeSchema,
  describeTargetKind,
  runLogText,
  timeline,
  type RunLog,
  type StepTimeline,
} from "../../lib/runLog";

interface Props {
  runs: RunLog[];
  selectedId: string | null;
  onSelect: (runId: string) => void;
  onClear: () => void;
  onExport: (log: RunLog, extension: "json" | "txt") => Promise<string | null>;
}

const verdictLabel: Record<StepTimeline["verdict"], string> = {
  pass: "Passed",
  fail: "Failed",
  skipped: "Skipped",
  running: "Running",
};

/**
 * A collection's past runs, and the log of the one picked: each step in order
 * with when it started, what it sent and got back, the values passed to it
 * from earlier steps, and why it failed or was skipped.
 */
export function RunLogView({ runs, selectedId, onSelect, onClear, onExport }: Props) {
  const current = runs.find((run) => run.id === selectedId) ?? runs[0] ?? null;
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => setNote(null), [current?.id]);

  if (!runs.length) {
    return (
      <div className="empty runlog-empty">
        <p>
          No runs yet. Press <strong>Run</strong> and each run's log is kept here: every step in order, the values passed
          between steps, and why a step failed or was skipped.
        </p>
        <p className="meta">The last 20 runs are kept on this computer, with secret values replaced by their names.</p>
      </div>
    );
  }

  return (
    <div className="runlog">
      <aside className="runlog-runs" aria-label="Past runs">
        <div className="runlog-runs-head">
          <span className="group-label">Runs · {runs.length}</span>
          <span className="spacer" />
          <button type="button" className="btn ghost tight" onClick={onClear} title="Forget this collection's runs">
            <Trash2 size={12} aria-hidden /> Clear
          </button>
        </div>
        <ol className="runlog-run-list">
          {runs.map((run) => {
            const failed = (run.counts?.failed ?? 0) > 0;
            return (
              <li key={run.id}>
                <button
                  type="button"
                  className="runlog-run"
                  aria-current={run.id === current?.id ? "true" : undefined}
                  onClick={() => onSelect(run.id)}
                  title={absoluteTime(run.startedAt)}
                >
                  <span className={`run-dot ${!run.counts ? "not_run" : failed ? "fail" : "pass"}`} aria-hidden />
                  <span className="runlog-run-main">
                    <span className="runlog-run-when">{run.counts ? relativeTime(run.startedAt) : "Running…"}</span>
                    <span className="summary">
                      {describeCounts(run)}
                      {run.environment ? ` · ${run.environment}` : ""}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        <p className="field-meta runlog-kept">Last 20 runs, kept on this computer. Secret values are replaced by their names.</p>
      </aside>
      {current && (
        <RunDetail
          key={current.id}
          log={current}
          note={note}
          onCopy={() => {
            void navigator.clipboard?.writeText(runLogText(current)).catch(() => {});
            setNote("Copied the log as text.");
          }}
          onExport={(extension) =>
            void onExport(current, extension)
              .then((where) => where && setNote(`Exported to ${where}.`))
              .catch((error) => setNote(`Couldn't export: ${error instanceof Error ? error.message : String(error)}`))
          }
        />
      )}
    </div>
  );
}

function RunDetail({
  log,
  note,
  onCopy,
  onExport,
}: {
  log: RunLog;
  note: string | null;
  onCopy: () => void;
  onExport: (extension: "json" | "txt") => void;
}) {
  const steps = useMemo(() => timeline(log), [log]);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const started = log.events.find((e) => e.type === "run_started");
  const finished = log.events.find((e) => e.type === "run_finished");
  const toggle = (index: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  return (
    <section className="runlog-detail" aria-label="Run log">
      <header className="runlog-head">
        <div className="runlog-title-row">
          <h2>{absoluteTime(log.startedAt)}</h2>
          <span className={`meta ${(log.counts?.failed ?? 0) > 0 ? "warn" : ""}`}>{describeCounts(log)}</span>
          <span className="spacer" />
          <button type="button" className="btn tight" onClick={onCopy}>
            <Copy size={12} aria-hidden /> Copy as text
          </button>
          <button type="button" className="btn tight" onClick={() => onExport("json")} disabled={!log.counts}>
            <Download size={12} aria-hidden /> Export JSON…
          </button>
          <button type="button" className="btn tight" onClick={() => onExport("txt")} disabled={!log.counts}>
            Export text…
          </button>
        </div>
        <div className="runlog-facts meta">
          <span>env: {log.environment ?? "none"}</span>
          {started?.type === "run_started" && started.targets.length > 0 && <span>targets: {started.targets.join(", ")}</span>}
          {started?.type === "run_started" && started.stopOnFailure && <span>stops at the first failure</span>}
          {log.stoppedEarly && <span className="warn">stopped early</span>}
          {log.truncated && <span>some events left out to keep the log small</span>}
        </div>
        {note && (
          <p className="field-meta" role="status">
            {note}
          </p>
        )}
      </header>

      <ol className="runlog-timeline">
        {started && (
          <li className="runlog-line run">
            <span className="runlog-t">+0 ms</span>
            <span className="runlog-what">Run started</span>
          </li>
        )}
        {steps.map((step) => {
          const expanded = open.has(step.index);
          return (
            <li key={step.index} className={`runlog-step ${step.verdict}`}>
              <button
                type="button"
                className="runlog-line"
                aria-expanded={expanded}
                onClick={() => toggle(step.index)}
              >
                <span className="runlog-t">{step.t !== undefined ? `+${step.t} ms` : ""}</span>
                <span className="runlog-chevron" aria-hidden>
                  {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </span>
                <span className="runlog-what">
                  <span className="step-index">{step.index + 1}</span>
                  <span className="runlog-name">{step.name}</span>
                  {step.method && <span className={`method ${step.method.toLowerCase()}`}>{step.method}</span>}
                  {step.url && <span className="runlog-url">{step.url}</span>}
                </span>
                <span className="runlog-status">
                  {step.status !== undefined ? step.status : step.error ? "error" : ""}
                  {step.ms !== undefined ? ` · ${step.ms} ms` : ""}
                </span>
                <span className={`runlog-verdict ${step.verdict}`}>{verdictLabel[step.verdict]}</span>
              </button>
              {step.verdict !== "pass" && step.reason && (
                <p className="runlog-reason">
                  {step.cause && <strong>{describeCause(step.cause)}: </strong>}
                  {step.reason}
                </p>
              )}
              {step.links.some((link) => link.error) && !expanded && (
                <p className="runlog-reason subtle">
                  {step.links.filter((link) => link.error).length} value
                  {step.links.filter((link) => link.error).length === 1 ? "" : "s"} couldn't be resolved. Open the step for details.
                </p>
              )}
              {expanded && <StepDetails step={step} />}
            </li>
          );
        })}
        {finished?.type === "run_finished" && (
          <li className="runlog-line run">
            <span className="runlog-t">+{finished.t} ms</span>
            <span className="runlog-what">
              Run finished · {describeCounts(log)}
              {finished.stoppedEarly
                ? finished.stopReason === "stopped"
                  ? " · stopped by you"
                  : " · stopped at the first failure"
                : ""}
            </span>
          </li>
        )}
      </ol>
    </section>
  );
}

function StepDetails({ step }: { step: StepTimeline }) {
  const headers = Object.entries(step.requestHeaders ?? {});
  return (
    <dl className="runlog-details">
      {step.at && (
        <>
          <dt>Started</dt>
          <dd>{absoluteTime(step.at)}</dd>
        </>
      )}
      {(step.target || step.targetKind) && (
        <>
          <dt>Target</dt>
          <dd>
            {step.target ?? ""}
            {step.targetKind ? `${step.target ? " · " : ""}${describeTargetKind(step.targetKind)}` : ""}
          </dd>
        </>
      )}
      {step.links.length > 0 && (
        <>
          <dt>Values used</dt>
          <dd>
            <ul className="runlog-links">
              {step.links.map((link, i) => (
                <li key={i} className={link.error ? "bad" : ""}>
                  {link.target && <span className="runlog-link-target">{link.target} ← </span>}
                  <code>{link.source}</code>
                  {link.error ? (
                    <span className="runlog-link-error"> couldn't be resolved: {link.error}</span>
                  ) : (
                    <>
                      {" = "}
                      <code className="runlog-link-value">{link.value}</code>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </dd>
        </>
      )}
      {step.method && step.url && (
        <>
          <dt>Request</dt>
          <dd>
            <code>
              {step.method} {step.url}
            </code>
          </dd>
        </>
      )}
      {headers.length > 0 && (
        <>
          <dt>Headers</dt>
          <dd>
            <ul className="runlog-headers">
              {headers.map(([name, value]) => (
                <li key={name}>
                  <code>
                    {name}: {value}
                  </code>
                </li>
              ))}
            </ul>
          </dd>
        </>
      )}
      {step.error && (
        <>
          <dt>Network error</dt>
          <dd className="bad">{step.error}</dd>
        </>
      )}
      {step.status !== undefined && (
        <>
          <dt>Response</dt>
          <dd>
            {step.status}
            {step.statusText ? ` ${step.statusText}` : ""}
            {step.ms !== undefined ? ` · ${step.ms} ms` : ""}
            {step.bytes !== undefined ? ` · ${step.bytes} bytes` : ""}
          </dd>
        </>
      )}
      {step.expected && (
        <>
          <dt>Expected status</dt>
          <dd className={step.expected.ok ? "" : "bad"}>
            {step.expected.expected} · {step.expected.ok ? "matched" : `got ${step.expected.actual}`}
          </dd>
        </>
      )}
      {step.status !== undefined && (
        <>
          <dt>Schema</dt>
          <dd className={step.schema?.result === "mismatch" || step.schema?.result === "error" ? "bad" : ""}>
            {describeSchema(step.schema)}
          </dd>
        </>
      )}
      {step.warnings && (
        <>
          <dt>Local mock</dt>
          <dd>
            <ul>
              {step.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </dd>
        </>
      )}
      {step.verdict === "pass" && step.reason && (
        <>
          <dt>Note</dt>
          <dd>{step.reason}</dd>
        </>
      )}
    </dl>
  );
}
