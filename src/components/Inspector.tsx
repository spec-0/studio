import { useState } from "react";
import { Download, History } from "lucide-react";
import type { ResponseResult } from "../lib/request";
import type { ValidationResult } from "../lib/validate";

interface Props {
  result: ResponseResult | null;
  validation: ValidationResult | null;
  error: string | null;
  curl: string | null;
  onDismissHook: () => void;
  showHook: boolean;
  /**
   * The request went to a mock that was provisioned before the spec was last
   * synced. A mismatch is then very likely version skew rather than real drift,
   * and calling it drift would poison the verdict this feature exists for.
   * Resolved properly when the platform can re-provision a mock.
   */
  mockStale?: boolean;
  /** Present when the mock can be rebuilt from here — connected, and we know its id. */
  onRefreshMock?: () => void;
  /** Write the held binary body somewhere the user chooses. */
  onSaveBody?: (contentType: string, byteLength: number) => void;
  /**
   * No spec describes this response, so there is nothing to check it against.
   *
   * Said out loud rather than left blank: an empty verdict area next to a 200
   * reads as "checked, fine", and claiming a check that never ran is the one
   * thing this pane must not do.
   */
  noSchema?: boolean;
  /**
   * The answer was brought back from earlier this session, when its request
   * was shown again: when it was sent, and whether the request has been
   * edited since. Said above everything else, so it never reads as new.
   */
  restored?: { sentAt: string; editedSince: boolean } | null;
}

const KIND_GLYPH: Record<string, string> = {
  extra_field: "⚠",
  missing_required: "✗",
  type_mismatch: "✗",
  other: "•",
};

export function Inspector({
  result,
  validation,
  error,
  curl,
  showHook,
  onDismissHook,
  mockStale = false,
  onRefreshMock,
  onSaveBody,
  noSchema = false,
  restored = null,
}: Props) {
  const [view, setView] = useState<"body" | "headers" | "curl">("body");

  const restoredNote = restored && (
    <div className="verdict none restored-note" role="status">
      <History size={13} className="glyph" aria-hidden="true" />
      <span>
        Sent at {clockTime(restored.sentAt)}, earlier in this session. Not sent again since.
        {restored.editedSince && " The request has been edited since, so this isn't its answer."}
      </span>
    </div>
  );

  if (error) {
    return (
      <>
        <div className="insp-head">
          <strong style={{ fontSize: 12 }}>Request failed</strong>
        </div>
        <div className="insp-body">
          {restoredNote}
          <div className="error-box">{error}</div>
        </div>
      </>
    );
  }

  if (!result) {
    return (
      <>
        <div className="insp-head">
          <strong style={{ fontSize: 12 }}>Response</strong>
        </div>
        <div className="insp-body">
          <div className="meta">
            {noSchema
              ? "Send a request to see the response."
              : "Send a request to see the response and its schema check."}
          </div>
        </div>
      </>
    );
  }

  const family = Math.floor(result.status / 100);
  const pretty = result.json !== undefined ? JSON.stringify(result.json, null, 2) : result.bodyText;
  const binary = result.binary ?? null;

  return (
    <>
      <div className="insp-head">
        <span className={`status-pill s${family}`}>{result.status}</span>
        <span className="meta">{result.statusText}</span>
        <span className="meta" style={{ marginLeft: "auto" }}>
          {result.ms}ms · {formatBytes(result.bytes)}
        </span>
      </div>

      <div className="insp-body">
        {restoredNote}
        {result.redirects && result.redirects.length > 0 && (
          <div className="verdict none">
            <span className="glyph">↳</span>
            <span>
              Followed {result.redirects.length}{" "}
              {result.redirects.length === 1 ? "redirect" : "redirects"} — this answer came from{" "}
              <span className="mono">{result.redirects[result.redirects.length - 1]}</span>, not the
              URL you sent to.
            </span>
          </div>
        )}
        {validation && (
          <Verdict validation={validation} mockStale={mockStale} onRefreshMock={onRefreshMock} />
        )}

        {noSchema && (
          <div className="verdict none">
            <span className="glyph">–</span>
            <span>
              Not checked — no spec describes this response. Import or publish the API and every
              response gets validated against it.
            </span>
          </div>
        )}

        {validation?.status === "mismatch" && showHook && !mockStale && (
          <div className="hook">
            This response doesn&apos;t match your spec. spec0 catches this across your whole org,
            automatically.{" "}
            <button
              className="btn"
              style={{ padding: "1px 7px", marginLeft: 4 }}
              onClick={onDismissHook}
            >
              Dismiss
            </button>
          </div>
        )}

        <div style={{ display: "flex", gap: 4, margin: "14px 0 8px" }}>
          {(["body", "headers", "curl"] as const).map((tab) => (
            <button
              key={tab}
              className="btn"
              style={
                view === tab
                  ? { borderColor: "hsl(var(--primary))", color: "hsl(var(--primary))" }
                  : undefined
              }
              onClick={() => setView(tab)}
            >
              {tab}
            </button>
          ))}
          <button
            className="btn"
            style={{ marginLeft: "auto" }}
            onClick={() =>
              navigator.clipboard.writeText(view === "curl" ? (curl ?? "") : pretty)
            }
          >
            Copy
          </button>
        </div>

        {view === "body" &&
          (binary ? (
            <div className="binary-body">
              {binary.previewBase64 && binary.contentType.startsWith("image/") ? (
                <img
                  className="binary-preview"
                  alt="Response body"
                  src={`data:${binary.contentType};base64,${binary.previewBase64}`}
                />
              ) : (
                <div className="verdict none">
                  <span className="glyph">◈</span>
                  <span>
                    {binary.contentType || "Binary"} · {formatBytes(binary.byteLength)} — not text,
                    so there's nothing useful to show here.
                  </span>
                </div>
              )}
              {binary.path && (
                <button
                  className="btn"
                  style={{ marginTop: 10 }}
                  onClick={() => onSaveBody?.(binary.contentType, binary.byteLength)}
                >
                  <Download size={13} /> Save as…
                </button>
              )}
            </div>
          ) : (
            <pre className="code">{pretty || "(empty body)"}</pre>
          ))}
        {view === "curl" && <pre className="code">{curl ?? ""}</pre>}
        {view === "headers" && (
          <table className="fields">
            <tbody>
              {Object.entries(result.headers).map(([key, value]) => (
                <tr key={key}>
                  <td className="name">{key}</td>
                  <td className="desc" style={{ overflowWrap: "anywhere" }}>
                    {value}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function Verdict({
  validation,
  mockStale,
  onRefreshMock,
}: {
  validation: ValidationResult;
  mockStale: boolean;
  onRefreshMock?: () => void;
}) {
  if (validation.status === "ok") {
    return (
      <div className="verdict ok">
        <span className="glyph">✓</span>
        <span>Response matches the declared schema.</span>
      </div>
    );
  }
  if (validation.status === "no_schema" || validation.status === "error") {
    return (
      <div className="verdict none">
        <span className="glyph">?</span>
        <span>{validation.note}</span>
      </div>
    );
  }

  const extra = validation.findings.filter((f) => f.kind === "extra_field").length;
  const broken = validation.findings.length - extra;

  if (mockStale) {
    return (
      <>
        <div className="verdict warn">
          <span className="glyph">⚠</span>
          <span>
            This mock serves an older version of the spec, so these differences are version skew
            rather than drift.
            {onRefreshMock ? " Rebuild it to compare like for like — same URL and key." : ""}
          </span>
          {onRefreshMock && (
            <button className="btn" style={{ marginLeft: "auto" }} onClick={onRefreshMock}>
              Rebuild mock
            </button>
          )}
        </div>
        <div>
          {validation.findings.map((finding, index) => (
            <div className={`finding ${finding.kind}`} key={`${finding.path}-${index}`}>
              <span className="glyph">{KIND_GLYPH[finding.kind]}</span>
              <span className="fpath">{finding.path}</span>
              <span style={{ flex: 1 }}>{finding.message}</span>
            </div>
          ))}
        </div>
      </>
    );
  }

  return (
    <>
      <div className="verdict warn">
        <span className="glyph">⚠</span>
        <span>
          Response diverges from the spec —{" "}
          {[
            extra ? `${extra} undeclared field${extra > 1 ? "s" : ""}` : null,
            broken ? `${broken} schema violation${broken > 1 ? "s" : ""}` : null,
          ]
            .filter(Boolean)
            .join(", ")}
          .
        </span>
      </div>
      <div>
        {validation.findings.map((finding, index) => (
          <div className={`finding ${finding.kind}`} key={`${finding.path}-${index}`}>
            <span className="glyph">{KIND_GLYPH[finding.kind]}</span>
            <span className="fpath">{finding.path}</span>
            <span style={{ flex: 1 }}>{finding.message}</span>
          </div>
        ))}
      </div>
    </>
  );
}

/** "14:03:12" today, or the date as well for anything older. */
function clockTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
