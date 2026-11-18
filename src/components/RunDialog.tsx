import { useMemo, useState } from "react";
import { Copy, Loader2, Play, Square } from "lucide-react";
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
import { Dialog } from "./Dialog";
import { plural } from "../lib/plural";

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
    <Dialog
      title="Run against the spec"
      subtitle={
        <>
          Against <span className="mono">{target || "the current target"}</span>, one request at a time
        </>
      }
      wide
      busy={running}
      onClose={onClose}
      footerContext={
        results.length > 0 && !running ? (
          <button className="btn ghost" onClick={onCopyReport}>
            <Copy size={13} /> Copy report
          </button>
        ) : (
          "Results go to History as one run."
        )
      }
      footer={
        <>
          {running ? (
            <button className="btn danger-outline" onClick={onCancel}>
              <Square size={12} /> Stop
            </button>
          ) : (
            <>
              <button className="btn" onClick={onClose}>
                {results.length ? "Close" : "Cancel"}
              </button>
              <button
                className="btn primary"
                disabled={willRun === 0}
                onClick={() =>
                  onRun(selected, { includeMutating }, scope === "__all__" ? "every operation" : `tag: ${scope}`)
                }
              >
                <Play size={13} /> Run {plural(willRun, "operation")}
              </button>
            </>
          )}
        </>
      }
    >
      <div className="rows">
        <div className="row-s">
          <div className="l">
            <b>Operations</b>
          </div>
          <div className="c">
            <select className="select" value={scope} onChange={(e) => setScope(e.target.value)} disabled={running}>
              <option value="__all__">Every operation ({operations.length})</option>
              {tags.map((tag) => (
                <option key={tag} value={tag}>
                  {tag} ({operations.filter((op) => op.tag === tag).length})
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="row-s">
          <div className="l">
            <b>Include methods that change state</b>
            <span className="meta">
              {mutatingCount > 0
                ? `${plural(mutatingCount, "POST, PUT, PATCH or DELETE operation", "POST, PUT, PATCH or DELETE operations")} here.`
                : "None here; only reads will run."}
            </span>
          </div>
          <div className="c">
            <input
              type="checkbox"
              className="switch"
              role="switch"
              aria-label="Include methods that change state"
              checked={includeMutating}
              disabled={running || mutatingCount === 0}
              onChange={(e) => setIncludeMutating(e.target.checked)}
            />
          </div>
        </div>
      </div>
      {includeMutating && mutatingCount > 0 && (
        <div className="verdict warn" style={{ marginTop: 8 }}>
          <span className="glyph">⚠</span>
          <span>
            This run will send {plural(mutatingCount, "request")} that change state, against{" "}
            <span className="mono">{target || "the current target"}</span>.
          </span>
        </div>
      )}

      {results.length === 0 && (
        <>
          <div className="label run-plan-label">
            Will run <span className="mono">{willRun}</span>
          </div>
          <table className="tbl run-plan">
            <tbody>
              {preview
                .filter((p) => !p.skip)
                .map((p) => (
                  <tr key={p.operation.id}>
                    <td className="used-method">
                      <span className={`method ${p.operation.method.toLowerCase()}`}>{p.operation.method}</span>
                    </td>
                    <td className="mono">{p.operation.path}</td>
                    <td className="meta">{p.operation.summary ?? ""}</td>
                  </tr>
                ))}
              {willRun === 0 && (
                <tr>
                  <td colSpan={3} className="meta">
                    Nothing here can run yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {preview.some((p) => p.skip) && (
            <>
              <div className="label run-plan-label">
                Won&apos;t run <span className="mono">{preview.length - willRun}</span>
              </div>
              <table className="tbl run-plan">
                <tbody>
                  {preview
                    .filter((p) => p.skip)
                    .map((p) => (
                      <tr key={p.operation.id}>
                        <td className="used-method">
                          <span className={`method ${p.operation.method.toLowerCase()}`}>{p.operation.method}</span>
                        </td>
                        <td className="mono">{p.operation.path}</td>
                        <td className="meta">{describeSkip(p.skip!)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}

      {results.length > 0 && (
        <section className="section">
          <h3>
            Results
            {summary && <span className="meta"> · {describeSummary(summary)}</span>}
          </h3>
          <table className="tbl run-results">
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
    </Dialog>
  );
}
