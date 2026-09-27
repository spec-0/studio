import type { ReactNode } from "react";
import { inTauri } from "../lib/request";

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
    </div>
  );
}
