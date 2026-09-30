import type { ReactNode } from "react";
import { SquareTerminal } from "lucide-react";
import { toggleConsole } from "../lib/appConsole";
import { isMac } from "../lib/platform";
import { inTauri } from "../lib/request";
import { consoleShortcutLabel } from "../lib/shortcuts";
import { useAppConsole } from "../hooks/useAppConsole";

interface Props {
  /** The leading text: what is on screen. */
  summary: ReactNode;
  envName?: string | null;
  /** The spec0 org, when signed in and the view shows it. */
  orgName?: string | null;
  /** The last response, for its status and time. */
  result: { status: number; ms: number } | null;
}

/** The bottom bar: what is open, the environment, how requests are sent, and the last result. */
export function StatusBar({ summary, envName, orgName, result }: Props) {
  const { open, unseenErrors } = useAppConsole();
  return (
    <div className="statusbar">
      <span>{summary}</span>
      {envName != null && <span>env: {envName}</span>}
      {orgName != null && <span>spec0: {orgName}</span>}
      <span style={{ marginLeft: "auto" }}>
        {inTauri ? "requests via Rust · no CORS" : "browser preview · CORS applies"}
      </span>
      {result && (
        <span>
          {result.status} · {result.ms}ms
        </span>
      )}
      <button
        type="button"
        className={`statusbar-console${open ? " on" : ""}`}
        aria-pressed={open}
        aria-label={`Console${unseenErrors ? `, ${unseenErrors} new error${unseenErrors === 1 ? "" : "s"}` : ""}`}
        title={`Console: requests, runs, local mock and MCP activity (${consoleShortcutLabel(isMac)})`}
        onClick={toggleConsole}
      >
        <SquareTerminal size={12} aria-hidden /> Console
        {unseenErrors > 0 && <span className="statusbar-badge">{unseenErrors > 99 ? "99+" : unseenErrors}</span>}
      </button>
    </div>
  );
}
