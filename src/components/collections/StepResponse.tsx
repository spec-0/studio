import type { ReactNode } from "react";
import { referenceFor, type PathSegment } from "../../lib/chain";
import type { StepResult } from "../../lib/collectionRun";

interface Props {
  stepKey: string;
  result: StepResult | undefined;
  running: boolean;
  /** Clicking a value in the response: offer to use it in a later step. */
  onPick: (reference: string, anchor: DOMRect) => void;
}

/**
 * A step's result from the last run: pass or fail and why, what the schema
 * check found, and the response, where every value can be clicked to use it
 * in a later step.
 */
export function StepResponse({ stepKey, result, running, onPick }: Props) {
  if (running && !result) return <div className="empty"><p>Running…</p></div>;
  if (!result) {
    return (
      <div className="empty">
        <p>This step hasn't run yet. Run the collection to see its response here.</p>
      </div>
    );
  }
  const family = result.status ? Math.floor(result.status / 100) : 0;
  return (
    <div className="step-response">
      <div className="step-result-head">
        {result.status !== undefined && <span className={`status-pill s${family}`}>{result.status}</span>}
        {result.ms !== undefined && <span className="meta">{result.ms} ms</span>}
        {result.mock && <span className="tag mock">mock</span>}
        {result.request && (
          <span className="meta step-url" title={result.request.url}>
            {result.request.method} {result.request.url}
          </span>
        )}
      </div>
      <div className={`verdict ${result.verdict === "pass" ? (result.reason ? "none" : "ok") : "warn"}`} role="status">
        <span className="glyph">{result.verdict === "pass" ? "✓" : result.verdict === "fail" ? "✕" : "–"}</span>
        <span>
          {result.verdict === "pass" ? "Passed" : result.verdict === "fail" ? "Failed" : "Not run"}
          {result.reason ? ` · ${result.reason}` : result.verdict === "pass" ? " · the response matches the spec." : ""}
        </span>
      </div>
      {result.mockWarnings && result.mockWarnings.length > 0 && (
        <div className="section">
          <h3>What the local mock said about the request</h3>
          {result.mockWarnings.map((warning, index) => (
            <div className="finding extra_field" key={index}>
              <span className="glyph">●</span>
              <span>{warning}</span>
            </div>
          ))}
          <div className="field-meta">
            The mock answered anyway. The request doesn't match the spec, so a real server may refuse it.
          </div>
        </div>
      )}
      {result.validation && result.validation.findings.length > 0 && (
        <div className="section">
          <h3>Differences from the spec</h3>
          {result.validation.findings.map((finding, index) => (
            <div className={`finding ${finding.kind}`} key={index}>
              <span className="glyph">●</span>
              <span className="fpath">{finding.path || "(root)"}</span>
              <span>{finding.message}</span>
            </div>
          ))}
        </div>
      )}
      {result.output && (
        <>
          <div className="section">
            <h3>
              Response body
              <span className="meta step-hint">click a value to use it in a later step</span>
            </h3>
            {result.output.json !== undefined ? (
              <pre className="code json-tree" aria-label="Response body">
                <JsonNode
                  value={result.output.json}
                  path={["body"]}
                  onPick={(path, rect) => onPick(referenceFor(stepKey, path), rect)}
                />
              </pre>
            ) : (
              <pre className="code">{result.output.text || "(empty)"}</pre>
            )}
          </div>
          <div className="section">
            <h3>Response headers</h3>
            <table className="fields">
              <tbody>
                {Object.entries(result.output.headers).map(([name, value]) => (
                  <tr key={name}>
                    <td className="name">{name}</td>
                    <td className="desc">
                      <button
                        type="button"
                        className="json-value"
                        title={`Use ${referenceFor(stepKey, ["headers", name])}`}
                        onClick={(event) =>
                          onPick(
                            referenceFor(stepKey, ["headers", name]),
                            event.currentTarget.getBoundingClientRect(),
                          )
                        }
                      >
                        {value}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

const INDENT = "  ";

/** JSON, printed as usual, with each leaf value a button. */
function JsonNode({
  value,
  path,
  depth = 0,
  onPick,
}: {
  value: unknown;
  path: PathSegment[];
  depth?: number;
  onPick: (path: PathSegment[], rect: DOMRect) => void;
}): ReactNode {
  const pad = INDENT.repeat(depth + 1);
  const close = INDENT.repeat(depth);
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return (
      <>
        {"[\n"}
        {value.map((item, index) => (
          <span key={index}>
            {pad}
            <JsonNode value={item} path={[...path, index]} depth={depth + 1} onPick={onPick} />
            {index < value.length - 1 ? ",\n" : "\n"}
          </span>
        ))}
        {close}]
      </>
    );
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return "{}";
    return (
      <>
        {"{\n"}
        {entries.map(([key, item], index) => (
          <span key={key}>
            {pad}
            <span className="tk-key">{JSON.stringify(key)}</span>
            {": "}
            <JsonNode value={item} path={[...path, key]} depth={depth + 1} onPick={onPick} />
            {index < entries.length - 1 ? ",\n" : "\n"}
          </span>
        ))}
        {close}
        {"}"}
      </>
    );
  }
  const text = JSON.stringify(value);
  const kind = typeof value === "string" ? "string" : typeof value === "number" ? "number" : "literal";
  return (
    <button
      type="button"
      className={`json-value tk-${kind}`}
      title={`Use ${referenceFor("x", path).slice("{{steps.x.".length, -2)} in a later step`}
      onClick={(event) => onPick(path, event.currentTarget.getBoundingClientRect())}
    >
      {text}
    </button>
  );
}
