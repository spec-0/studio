import { useState } from "react";
import { Check, Copy, Download, History, Send, Terminal, WrapText, X } from "lucide-react";
import type { ResponseResult } from "../lib/request";
import type { ValidationResult } from "../lib/validate";
import { TabList } from "./TabList";
import { EmptyState } from "./EmptyState";
import { shortcut } from "../lib/platform";
import { plural } from "../lib/plural";
import { CodeBlock } from "./CodeBlock";

interface Props {
  result: ResponseResult | null;
  validation: ValidationResult | null;
  error: string | null;
  onDismissHook: () => void;
  showHook: boolean;
  /**
   * The request went to a mock that was provisioned before the spec was last
   * synced. A mismatch is then very likely version skew rather than real drift,
   * and calling it drift would poison the verdict this feature exists for.
   */
  mockStale?: boolean;
  /** Present when the mock can be rebuilt from here: connected, and we know its id. */
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
  /** Where the request went, in words, so the answer says where it came from. */
  sentTo?: string | null;
  /** The schema the response was checked against, e.g. "Order". */
  schemaName?: string | null;
  /** Open a schema in the Schemas view. */
  onShowSchema?: (name: string) => void;
  /** The sent request as cURL, for a request without a Send menu (Scratch). */
  curl?: string | null;
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
  showHook,
  onDismissHook,
  mockStale = false,
  onRefreshMock,
  onSaveBody,
  noSchema = false,
  restored = null,
  sentTo = null,
  schemaName = null,
  onShowSchema,
  curl = null,
}: Props) {
  const [view, setView] = useState<"body" | "headers">("body");
  const [wrap, setWrap] = useState(false);

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
        <EmptyState
          icon={<Send size={18} />}
          title="No response yet"
          body={
            <>
              {noSchema ? "Send the request to see its response here." : "Send the request to see its response and schema check here."}{" "}
              <span className="kbd">{shortcut("↵")}</span>
            </>
          }
        />
      </>
    );
  }

  const family = Math.floor(result.status / 100);
  const pretty = result.json !== undefined ? JSON.stringify(result.json, null, 2) : result.bodyText;
  const binary = result.binary ?? null;
  const headerCount = Object.keys(result.headers).length;

  return (
    <>
      <div className="insp-head res-head">
        <span className={`status-badge s${family}`}>
          {result.status}
          {result.statusText ? ` ${result.statusText}` : ""}
        </span>
        <span className="metric mono">{result.ms} ms</span>
        <span className="metric mono">{formatBytes(result.bytes)}</span>
        {sentTo && (
          <span className="chip sans res-target" title={`This answer came from ${sentTo}`}>
            {/mock/i.test(sentTo) && <span className="dot live" aria-hidden />}
            {shortTarget(sentTo)}
          </span>
        )}
        <span className="spacer" />
        <VerdictLine
          validation={noSchema ? null : validation}
          noSchema={noSchema}
          schemaName={schemaName}
          onShowSchema={onShowSchema}
        />
      </div>

      <div className="insp-body">
        {restoredNote}
        {result.redirects && result.redirects.length > 0 && (
          <div className="verdict none">
            <span className="glyph">↳</span>
            <span>
              Followed {result.redirects.length}{" "}
              {result.redirects.length === 1 ? "redirect" : "redirects"}. This answer came from{" "}
              <span className="mono">{result.redirects[result.redirects.length - 1]}</span>, not the
              URL you sent to.
            </span>
          </div>
        )}
        {validation && validation.status !== "ok" && !noSchema && (
          <Verdict validation={validation} mockStale={mockStale} onRefreshMock={onRefreshMock} schemaName={schemaName} />
        )}

        {validation?.status === "mismatch" && showHook && !mockStale && (
          <div className="hook">
            This response doesn&apos;t match your spec. spec0 catches this across your whole org,
            automatically.{" "}
            <button className="btn sm" style={{ marginLeft: 4 }} onClick={onDismissHook}>
              Dismiss
            </button>
          </div>
        )}

        <div className="ptabs insp-tabs">
          <TabList<"body" | "headers">
            className="ptabs-list"
            tabClassName="ptab"
            label="Response"
            tabs={[
              { id: "body", label: "Body" },
              {
                id: "headers",
                label: (
                  <>
                    Headers <span className="c">{headerCount}</span>
                  </>
                ),
              },
            ]}
            selected={view}
            onSelect={setView}
          />
          <div className="tools">
            {curl && (
              <button className="btn ghost sm" onClick={() => void navigator.clipboard.writeText(curl)}>
                <Terminal size={13} /> Copy as cURL
              </button>
            )}
            {view === "body" && !binary && (
              <button
                className={`icon-btn${wrap ? " on" : ""}`}
                aria-pressed={wrap}
                aria-label="Wrap long lines"
                title="Wrap long lines"
                onClick={() => setWrap(!wrap)}
              >
                <WrapText size={14} />
              </button>
            )}
            <button
              className="btn ghost sm"
              onClick={() =>
                void navigator.clipboard.writeText(
                  view === "headers"
                    ? Object.entries(result.headers)
                        .map(([key, value]) => `${key}: ${value}`)
                        .join("\n")
                    : pretty,
                )
              }
            >
              <Copy size={13} /> Copy
            </button>
          </div>
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
                    {binary.contentType || "Binary"} · {formatBytes(binary.byteLength)}. Not text,
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
          ) : pretty ? (
            <CodeBlock text={pretty} syntax={result.json !== undefined ? "json" : "plain"} wrap={wrap} />
          ) : (
            <p className="meta">The response has no body.</p>
          ))}
        {view === "headers" && (
          <table className="tbl">
            <tbody>
              {Object.entries(result.headers).map(([key, value]) => (
                <tr key={key}>
                  <td className="mono">{key}</td>
                  <td className="mono" style={{ overflowWrap: "anywhere" }}>
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

/** "Local mock · 127.0.0.1:4011" → "local mock"; other targets as they are. */
function shortTarget(sentTo: string): string {
  if (sentTo.startsWith("Local mock")) return "local mock";
  if (sentTo === "Hosted mock") return "hosted mock";
  return sentTo;
}

/**
 * The verdict in one line, at the right of the header: "✓ Matches Order",
 * "✕ 2 differences from Order", or "Not checked". The schema's name opens it.
 */
function VerdictLine({
  validation,
  noSchema,
  schemaName,
  onShowSchema,
}: {
  validation: ValidationResult | null;
  noSchema: boolean;
  schemaName: string | null;
  onShowSchema?: (name: string) => void;
}) {
  const name = schemaName ? (
    onShowSchema && !schemaName.endsWith("[]") ? (
      <button className="mono verdict-schema" onClick={() => onShowSchema(schemaName)} title={`Open ${schemaName} in Schemas`}>
        {schemaName}
      </button>
    ) : (
      <span className="mono verdict-schema">{schemaName}</span>
    )
  ) : null;
  if (noSchema || !validation) {
    return <span className="verdict-line none" title="No spec describes this response">Not checked</span>;
  }
  if (validation.status === "ok") {
    return (
      <span className="verdict-line ok">
        <Check size={13} aria-hidden /> {name ? <>Matches {name}</> : "Matches the spec"}
      </span>
    );
  }
  if (validation.status === "mismatch") {
    const n = validation.findings.length;
    return (
      <span className="verdict-line bad">
        <X size={13} aria-hidden /> {plural(n, "difference")} {name ? <>from {name}</> : "from the spec"}
      </span>
    );
  }
  return <span className="verdict-line none" title={validation.note}>Not checked</span>;
}

/**
 * What's behind the one-line verdict: why a check couldn't run, or each
 * difference from the spec. A mock serving an older spec says so first, since
 * its differences are version skew rather than drift.
 */
function Verdict({
  validation,
  mockStale,
  onRefreshMock,
}: {
  validation: ValidationResult;
  mockStale: boolean;
  onRefreshMock?: () => void;
  schemaName?: string | null;
}) {
  if (validation.status === "no_schema" || validation.status === "error") {
    return validation.note ? (
      <div className="verdict none">
        <span className="glyph">?</span>
        <span>{validation.note}</span>
      </div>
    ) : null;
  }
  if (validation.status !== "mismatch") return null;
  return (
    <>
      {mockStale && (
        <div className="verdict warn">
          <span className="glyph">⚠</span>
          <span>
            This mock serves an older version of the spec, so these differences are version skew
            rather than drift.
            {onRefreshMock ? " Rebuild it to compare like for like (same URL and key)." : ""}
          </span>
          {onRefreshMock && (
            <button className="btn" style={{ marginLeft: "auto" }} onClick={onRefreshMock}>
              Rebuild mock
            </button>
          )}
        </div>
      )}
      <div className="findings">
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
