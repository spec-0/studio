import { useMemo, useState } from "react";
import { Copy, Loader2, Play, Square, X } from "lucide-react";
import {
  describeSkip,
  describeSummary,
  isSafeMethod,
  planRun,
  summarise,
  type RunOptions,
  type RunResult,
} from "../lib/runner";
import type { OperationSpec } from "../lib/spec";

interface Props {
  tags: string[];
  operations: OperationSpec[];
  vars: Record<string, string>;
  target: string;
  running: boolean;
  results: RunResult[];
  /** The operation currently in flight, for the progress line. */
  current: OperationSpec | null;
  onRun: (operations: OperationSpec[], options: RunOptions, scope: string) => void;
  onCancel: () => void;
  onCopyReport: () => void;
  onClose: () => void;
}

/**
 * Run a whole tag and report which responses match the spec.
 *
 * The assertions aren't written here or anywhere; they come from the schema
 * Studio already validates against. This dialog is the wiring: choose a scope,
 * decide about mutating methods, watch it go, take the report away.
 */
export function RunDialog({
  tags,
  operations,
  vars,
  target,
  running,
  results,
  current,
  onRun,
  onCancel,
  onCopyReport,
  onClose,
}: Props) {
  // Everything, not the first tag: opening on a tag whose only operation can't
  // run shows a disabled button and no explanation of which tag would work.
  const [scope, setScope] = useState<string>("__all__");
  const [includeMutating, setIncludeMutating] = useState(false);

  const selected = useMemo(
    () => (scope === "__all__" ? operations : operations.filter((op) => op.tag === scope)),
    [operations, scope],
  );

  // Shown before running, so the shape of the run is known in advance rather
  // than discovered as a page of skips.
  const preview = useMemo(
    () => planRun(selected, vars, { includeMutating }),
    [selected, vars, includeMutating],
  );
  const willRun = preview.filter((p) => !p.skip).length;
  const mutatingCount = selected.filter((op) => !isSafeMethod(op.method)).length;
  const summary = results.length ? summarise(results) : null;

  return (
    <div className="scrim" onClick={running ? undefined : onClose}>
      <div className="modal wide" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <strong>Run against the spec</strong>
          <span className="spacer" />
          <button className="icon-btn tight" onClick={onClose} aria-label="Close" disabled={running}>
            <X size={15} />
          </button>
        </div>

        <div className="modal-body">
          <section className="section">
            <div className="field">
              <div className="field-label">
                <div className="field-name">scope</div>
              </div>
              <select value={scope} onChange={(e) => setScope(e.target.value)} disabled={running}>
                <option value="__all__">Every operation ({operations.length})</option>
                {tags.map((tag) => (
                  <option key={tag} value={tag}>
                    {tag} ({operations.filter((op) => op.tag === tag).length})
                  </option>
                ))}
              </select>
            </div>

            <label className="check">
              <input
                type="checkbox"
                checked={includeMutating}
                disabled={running || mutatingCount === 0}
                onChange={(e) => setIncludeMutating(e.target.checked)}
              />
              Include methods that change state
              {mutatingCount > 0 && <span className="meta"> · {mutatingCount} here</span>}
            </label>
            {includeMutating && mutatingCount > 0 && (
              <div className="verdict warn" style={{ marginTop: 8 }}>
                <span className="glyph">⚠</span>
                <span>
                  This run will send {mutatingCount} request{mutatingCount === 1 ? "" : "s"} that
                  change state, against <span className="mono">{target || "the current target"}</span>.
                </span>
              </div>
            )}

            <div className="field-meta" style={{ marginTop: 10 }}>
              {willRun} of {preview.length} will run. Requests go one at a time: a burst at an
              internal service is a load test nobody asked for. Responses are checked against the
              schema the spec declares for the status actually returned.
            </div>
          </section>

          {results.length === 0 && preview.some((p) => p.skip) && (
            <section className="section">
              <h3>Won't run</h3>
              <table className="fields">
                <tbody>
                  {preview
                    .filter((p) => p.skip)
                    .map((p) => (
                      <tr key={p.operation.id}>
                        <td className="name mono">
                          {p.operation.method} {p.operation.path}
                        </td>
                        <td className="desc">{describeSkip(p.skip!)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </section>
          )}

          {results.length > 0 && (
            <section className="section">
              <h3>
                Results
                {summary && <span className="meta"> · {describeSummary(summary)}</span>}
              </h3>
              <table className="fields run-results">
                <tbody>
                  {results.map((result, index) => (
                    <tr key={`${result.operation.id}-${index}`}>
                      <td className="name">
                        <span className={`run-dot ${result.verdict}`} />
                        <span className="mono">
                          {result.operation.method} {result.operation.path}
                        </span>
                      </td>
                      <td className="type">
                        {result.status ? `${result.status} · ${result.ms}ms` : "–"}
                      </td>
                      <td className="desc">
                        {result.verdict === "skipped" && result.skip
                          ? describeSkip(result.skip)
                          : result.verdict === "error"
                            ? (result.error ?? "request failed")
                            : result.verdict === "mismatch"
                              ? `${result.validation?.findings.length ?? 0} difference(s) from the declared schema`
                              : result.verdict === "no_schema"
                                ? "no schema declared for this status"
                                : "matches the declared schema"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {running && current && (
            <div className="field-meta">
              <Loader2 size={12} className="spin" style={{ verticalAlign: "-2px" }} />{" "}
              {current.method} {current.path}…
            </div>
          )}
        </div>

        <div className="modal-foot">
          {results.length > 0 && !running && (
            <button className="btn" onClick={onCopyReport}>
              <Copy size={13} /> Copy report
            </button>
          )}
          <span className="spacer" />
          {running ? (
            <button className="btn danger-outline" onClick={onCancel}>
              <Square size={12} /> Stop
            </button>
          ) : (
            <button
              className="btn primary"
              disabled={willRun === 0}
              onClick={() =>
                onRun(selected, { includeMutating }, scope === "__all__" ? "every operation" : `tag: ${scope}`)
              }
            >
              <Play size={13} /> Run {willRun}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
