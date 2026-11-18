import { Layers, SquareTerminal } from "lucide-react";
import { toggleConsole } from "../lib/appConsole";
import { isMac } from "../lib/platform";
import { plural } from "../lib/plural";
import { inTauri } from "../lib/request";
import { consoleShortcutLabel } from "../lib/shortcuts";
import type { ValidationResult } from "../lib/validate";
import { useAppConsole } from "../hooks/useAppConsole";
import { useActiveRuns } from "../hooks/useRunActivity";
import { describeActive, openRun, type ActiveRun } from "../lib/runActivity";

interface Props {
  envName: string | null;
  onEditEnvironments: () => void;
  /** How many local mocks are running. */
  localMocks: number;
  onOpenMocks: () => void;
  /** The last response in the response pane: its status, time and check. */
  last: { status: number; ms: number; verdict: ValidationResult["status"] | null } | null;
}

const VERDICT: Partial<Record<ValidationResult["status"], string>> = {
  ok: "matched",
  mismatch: "differs from the spec",
  no_schema: "not checked",
};

/**
 * The bottom bar, the same on every page. Left: local mocks running and the
 * active environment. Right: a collection run in progress, how requests are
 * sent, the last request, and the console.
 */
export function StatusBar({ envName, onEditEnvironments, localMocks, onOpenMocks, last }: Props) {
  const { open, unseenErrors } = useAppConsole();
  const running = useActiveRuns();
  const consoleKey = consoleShortcutLabel(isMac);
  return (
    <div className="statusbar">
      {localMocks > 0 && (
        <button type="button" className="statusbar-item" onClick={onOpenMocks} title="Open Mocks">
          <span className="dot live" aria-hidden /> {plural(localMocks, "local mock")}
        </button>
      )}
      <button
        type="button"
        className="statusbar-item"
        onClick={onEditEnvironments}
        title="Edit environments"
      >
        <Layers size={12} aria-hidden /> {envName ?? "No environment"}
      </button>
      <span className="spacer" />
      {running.length > 0 && <RunIndicator runs={running} />}
      <span className="statusbar-transport" title={inTauri ? undefined : "Run the desktop app to send requests without CORS"}>
        {inTauri ? "requests via Rust · no CORS" : "browser preview · CORS applies"}
      </span>
      {last && (
        <span className="statusbar-last">
          Last request <span className={`mono status-ink s${Math.floor(last.status / 100)}`}>{last.status}</span>
          {" · "}
          <span className="mono">{last.ms} ms</span>
          {last.verdict && VERDICT[last.verdict] ? ` · ${VERDICT[last.verdict]}` : ""}
        </span>
      )}
      <button
        type="button"
        className={`statusbar-console${open ? " on" : ""}`}
        aria-pressed={open}
        aria-label={`Console${unseenErrors ? `, ${unseenErrors} new error${unseenErrors === 1 ? "" : "s"}` : ""}`}
        title={`Console: requests, runs, local mock, MCP and chat activity (${consoleKey})`}
        onClick={toggleConsole}
      >
        <SquareTerminal size={12} aria-hidden /> Console <span className="kbd">{consoleKey}</span>
        {unseenErrors > 0 && <span className="statusbar-badge">{unseenErrors > 99 ? "99+" : unseenErrors}</span>}
      </button>
    </div>
  );
}

/**
 * A collection running anywhere in Studio, started here or by an agent: its
 * name, the step it's on and a progress bar. Clicking it opens its runs.
 */
function RunIndicator({ runs }: { runs: ActiveRun[] }) {
  const run = runs[runs.length - 1];
  const others = runs.length - 1;
  const by = run.startedBy ? ` (started by ${run.startedBy})` : "";
  return (
    <button
      type="button"
      className="statusbar-run"
      title={runs.map((r) => describeActive(r) + (r.startedBy ? ` · ${r.startedBy}` : "")).join("\n")}
      onClick={() => openRun(run.collectionId, run.runId)}
    >
      <span className="statusbar-run-text">
        {describeActive(run)}
        {by}
        {others > 0 ? ` · ${others} more running` : ""}
      </span>
      <progress className="statusbar-run-bar" max={Math.max(run.total, 1)} value={run.done} aria-hidden />
    </button>
  );
}
