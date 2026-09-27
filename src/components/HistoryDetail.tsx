import { useEffect, useMemo, useState } from "react";
import { Copy, History as HistoryIcon, RefreshCw, X } from "lucide-react";
import {
  absoluteTime,
  copyDestination,
  fingerprint,
  isScratch,
  recheck,
  recordedCheck,
  relativeTime,
  responseFromEntry,
  specChange,
  type HistoryEntry,
} from "../lib/history";
import type { ParsedSpec } from "../lib/spec";
import type { Finding, ValidationResult } from "../lib/validate";

interface Props {
  entry: HistoryEntry;
  /**
   * The spec this entry's API has *now*, if it's in the library. Used to tell
   * whether the spec changed, to re-check on request, and to decide where a
   * copy can go. Null when the API isn't available.
   */
  spec: ParsedSpec | null;
  /** The spec is still being read, so copy and re-check wait for it. */
  specLoading?: boolean;
  onCopy: (entry: HistoryEntry, destination: "operation" | "scratch") => void;
  onClose?: () => void;
}

/**
 * One recorded request, read-only.
 *
 * Deliberately not the request editor: nothing here is an input, there is no
 * Send, and the only way to run it again is "Copy to a new request", which
 * opens an editor that says it's new. Showing a record in the live editors made
 * a response from three weeks ago look like one from three seconds ago; this
 * view exists so that can't happen.
 */
export function HistoryDetail({ entry, spec, specLoading = false, onCopy, onClose }: Props) {
  const [showing, setShowing] = useState<"recorded" | "current">("recorded");
  const [current, setCurrent] = useState<ValidationResult | null>(null);

  // A different entry starts from what was recorded, never from a re-check of the last one.
  useEffect(() => {
    setShowing("recorded");
    setCurrent(null);
  }, [entry.id]);

  useEffect(() => {
    if (!onClose) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Dialogs own Escape while they're open.
      if (document.querySelector(".scrim")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const scratch = isScratch(entry);
  const currentPrint = useMemo(() => (spec ? fingerprint(spec.sourceText) : undefined), [spec]);
  const change = scratch
    ? "unknown"
    : specChange(entry, spec ? { fingerprint: currentPrint, version: spec.version } : null);
  const operationGone =
    !scratch && spec !== null && !spec.operations.some((op) => op.id === entry.operationId);
  const destination = copyDestination(entry, spec);
  const canRecheck = !scratch && spec !== null && !operationGone && entry.responseBody !== undefined;
  const response = responseFromEntry(entry);
  const recorded = recordedCheck(entry);

  const doRecheck = () => {
    if (!spec) return;
    setCurrent(recheck(entry, spec));
    setShowing("current");
  };

  const pretty =
    response?.json !== undefined ? JSON.stringify(response.json, null, 2) : response?.bodyText;
  const family = Math.floor(entry.status / 100);

  return (
    <div className="record" aria-label="Recorded request">
      <header className="record-head">
        <div className="record-kicker">
          <HistoryIcon size={13} aria-hidden="true" />
          <span>Recorded request</span>
          <span className="record-ro">read-only</span>
          <span className="spacer" />
          {onClose && (
            <button
              className="icon-btn tight"
              onClick={onClose}
              title="Close (Esc)"
              aria-label="Close recorded request"
            >
              <X size={14} />
            </button>
          )}
        </div>
        <div className="record-title">
          <span className={`method ${entry.method.toLowerCase()}`}>{entry.method}</span>
          <span className="record-path">{entry.path}</span>
        </div>
        <div className="record-when">
          Ran <time dateTime={entry.at}>{absoluteTime(entry.at)}</time>
          <span className="record-sep">·</span>
          {relativeTime(entry.at)}
        </div>
        <dl className="record-facts">
          <div>
            <dt>API</dt>
            <dd>
              {entry.specTitle || "Untitled API"}
              {entry.specVersion && <span className="meta"> {entry.specVersion}</span>}
            </dd>
          </div>
          <div>
            <dt>Sent to</dt>
            <dd>{scratch ? "Typed URL" : entry.mock ? "Mock server" : "Real server"}</dd>
          </div>
          {entry.environment && (
            <div>
              <dt>Environment</dt>
              <dd>{entry.environment}</dd>
            </div>
          )}
          {entry.runId && (
            <div>
              <dt>From</dt>
              <dd>A run against the spec</dd>
            </div>
          )}
        </dl>
        <div className="record-actions">
          <button
            className="btn primary"
            disabled={specLoading}
            onClick={() => onCopy(entry, destination.kind)}
            title="Opens an editable request with these values. Nothing is sent until you send it."
          >
            <Copy size={13} />
            {destination.kind === "operation" || scratch
              ? "Copy to a new request"
              : "Copy to the scratch pad"}
          </button>
          {destination.kind === "scratch" && destination.reason && (
            <span className="record-note">{destination.reason}</span>
          )}
          {destination.kind === "scratch" && (
            <span className="record-note">The scratch pad holds one request; this replaces what's in it.</span>
          )}
        </div>
      </header>

      <div className="record-body">
        <section className="record-col" aria-label="What was sent">
          <h3 className="record-h">Sent</h3>
          <pre className="code record-line">
            <span className={`method ${entry.method.toLowerCase()}`}>{entry.method}</span> {entry.url}
          </pre>
          <HeaderTable title="Request headers" headers={entry.headers} />
          <h4 className="record-sub">Body</h4>
          {entry.body ? (
            <>
              <pre className="code">{entry.body}</pre>
              {entry.bodyKind && entry.bodyKind !== "text" && (
                <div className="field-meta" style={{ marginTop: 4 }}>
                  A summary of the {entry.bodyKind === "form" ? "form" : "multipart"} body — file
                  contents aren&apos;t recorded.
                </div>
              )}
            </>
          ) : (
            <div className="field-meta">No body.</div>
          )}
        </section>

        <section className="record-col" aria-label="What came back">
          <h3 className="record-h">Received</h3>
          <div className="record-status">
            <span className={`status-pill s${family}`}>{entry.status}</span>
            {entry.statusText && <span className="meta">{entry.statusText}</span>}
            <span className="meta" style={{ marginLeft: "auto" }}>
              {entry.ms}ms · {formatBytes(entry.bytes)}
            </span>
          </div>

          <h4 className="record-sub">
            Check
            {current !== null || showing === "current" ? (
              <span className="record-seg" role="tablist" aria-label="Which check result">
                <button
                  role="tab"
                  aria-selected={showing === "recorded"}
                  onClick={() => setShowing("recorded")}
                >
                  At the time
                </button>
                <button
                  role="tab"
                  aria-selected={showing === "current"}
                  onClick={() => setShowing("current")}
                >
                  Current spec
                </button>
              </span>
            ) : null}
          </h4>

          {showing === "recorded" ? (
            <>
              {!scratch && (
                <div className="record-note block">
                  {change === "changed"
                    ? "The spec has changed since this ran. This is the result against the spec as it was then."
                    : change === "same"
                      ? "The result from when this ran. The spec hasn't changed since."
                      : "The result from when this ran."}
                </div>
              )}
              {scratch ? (
                <div className="verdict none">
                  <span className="glyph">–</span>
                  <span>Not checked. A scratch request has no spec to check against.</span>
                </div>
              ) : recorded ? (
                <CheckResult result={recorded} />
              ) : (
                <div className="verdict none">
                  <span className="glyph">–</span>
                  <span>No check result was recorded for this request.</span>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="record-note block">
                Checked just now against the current spec
                {spec?.version ? ` (${spec.version})` : ""}, not the one this ran against.
              </div>
              {current ? (
                <CheckResult result={current} />
              ) : (
                <div className="verdict none">
                  <span className="glyph">–</span>
                  <span>This response can&apos;t be checked against the current spec.</span>
                </div>
              )}
            </>
          )}

          {!scratch && (
            <div className="record-recheck">
              {canRecheck ? (
                <button className="btn" onClick={doRecheck}>
                  <RefreshCw size={12} /> Re-check against current spec
                </button>
              ) : operationGone ? (
                <span className="field-meta">
                  This operation isn&apos;t in the current spec, so it can&apos;t be re-checked.
                </span>
              ) : spec === null && !specLoading ? (
                <span className="field-meta">
                  This API isn&apos;t in your library, so it can&apos;t be re-checked.
                </span>
              ) : null}
            </div>
          )}

          <HeaderTable title="Response headers" headers={entry.responseHeaders ?? {}} />
          <h4 className="record-sub">Body</h4>
          {response ? (
            <pre className="code">{pretty || "(empty body)"}</pre>
          ) : (
            <div className="field-meta">
              This entry was recorded before response bodies were kept.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/** Stored check result, with or without the findings older entries lack. */
function CheckResult({
  result,
}: {
  result: { status: ValidationResult["status"]; findings?: Finding[]; note?: string };
}) {
  if (result.status === "ok") {
    return (
      <div className="verdict ok">
        <span className="glyph">✓</span>
        <span>Response matched the declared schema.</span>
      </div>
    );
  }
  if (result.status === "no_schema" || result.status === "error") {
    return (
      <div className="verdict none">
        <span className="glyph">?</span>
        <span>
          {result.note ??
            (result.status === "no_schema"
              ? "The spec didn't declare a schema for this response."
              : "The check couldn't run.")}
        </span>
      </div>
    );
  }
  if (!result.findings) {
    return (
      <div className="verdict warn">
        <span className="glyph">⚠</span>
        <span>
          Response didn&apos;t match the spec. This entry was recorded before the details were
          kept, so only the verdict is known.
        </span>
      </div>
    );
  }
  return (
    <>
      <div className="verdict warn">
        <span className="glyph">⚠</span>
        <span>
          Response didn&apos;t match the spec — {result.findings.length}{" "}
          {result.findings.length === 1 ? "difference" : "differences"}.
        </span>
      </div>
      <div style={{ marginBottom: 12 }}>
        {result.findings.map((finding, index) => (
          <div className={`finding ${finding.kind}`} key={`${finding.path}-${index}`}>
            <span className="glyph">{KIND_GLYPH[finding.kind] ?? "•"}</span>
            <span className="fpath">{finding.path}</span>
            <span style={{ flex: 1 }}>{finding.message}</span>
          </div>
        ))}
      </div>
    </>
  );
}

const KIND_GLYPH: Record<string, string> = {
  extra_field: "⚠",
  missing_required: "✗",
  type_mismatch: "✗",
  other: "•",
};

function HeaderTable({ title, headers }: { title: string; headers: Record<string, string> }) {
  const rows = Object.entries(headers);
  return (
    <details className="record-headers" open={rows.length > 0 && rows.length <= 8}>
      <summary>
        {title} <span className="meta">{rows.length}</span>
      </summary>
      {rows.length ? (
        <table className="fields">
          <tbody>
            {rows.map(([key, value]) => (
              <tr key={key}>
                <td className="name">{key}</td>
                <td className="desc" style={{ overflowWrap: "anywhere" }}>
                  {value}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="field-meta">None.</div>
      )}
    </details>
  );
}

/**
 * The line an editor shows after "Copy to a new request". Dismissable, because
 * what it describes is genuinely new — unlike a recorded request, nothing here
 * can be mistaken for something that already happened.
 */
export function CopiedNote({ at, onDismiss }: { at: string; onDismiss: () => void }) {
  return (
    <div className="copied-note" role="status">
      <Copy size={12} aria-hidden="true" />
      <span>
        New request, copied from a recording on {absoluteTime(at)}. Nothing has been sent yet.
      </span>
      <button className="copied-note-close" onClick={onDismiss} aria-label="Dismiss" title="Dismiss">
        ×
      </button>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
