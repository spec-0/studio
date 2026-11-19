import { typeLabel, type OperationSpec, type ParamSpec, type ParsedSpec } from "../lib/spec";
import { Description } from "./Description";
import { SchemaFields } from "./SchemaFields";

const PARAM_ORDER: ParamSpec["in"][] = ["path", "query", "header", "cookie"];

/** A status's family for its badge colour: "2xx" and "default" read as their own families. */
function statusFamily(status: string): string {
  const first = status[0];
  return /[1-5]/.test(first) ? first : "";
}

/**
 * Everything the spec says about one operation, read-only: what it's for, what
 * the request takes, and what can come back.
 */
export function OperationDocs({ spec, op }: { spec: ParsedSpec; op: OperationSpec }) {
  const params = [...op.parameters].sort(
    (a, b) => PARAM_ORDER.indexOf(a.in) - PARAM_ORDER.indexOf(b.in),
  );
  const body = op.requestBody;
  const about = op.description ?? op.summary;
  const schemes = (op.security ?? []).map(
    (name) => spec.securitySchemes.find((s) => s.name === name) ?? { name, type: "" },
  );

  return (
    <div className="tab-pane op-docs">
      {about ? (
        <Description text={about} className="op-description" />
      ) : (
        <p className="meta">The spec has no description for this operation.</p>
      )}
      {op.deprecated && (
        <p className="meta op-docs-note">This operation is deprecated. The spec says it may be removed.</p>
      )}
      {op.externalDocs && (
        <Description
          className="op-description op-docs-note"
          text={`[${op.externalDocs.description || "More documentation"}](${op.externalDocs.url})`}
        />
      )}

      <section className="op-docs-section" aria-label="Request">
        <h3 className="label">Request</h3>
        {!params.length && !body && <p className="meta">No parameters and no body.</p>}
        {params.length > 0 && (
          <table className="tbl op-docs-params">
            <thead>
              <tr>
                <th>Parameter</th>
                <th>In</th>
                <th>Type</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {params.map((p) => (
                <tr key={`${p.in}:${p.name}`}>
                  <td className="mono top">
                    {p.name}
                    {p.required && <span className="required-word">required</span>}
                  </td>
                  <td className="top">{p.in}</td>
                  <td className="mono top type-cell">{typeLabel(spec.doc, p.schema)}</td>
                  <td className="top">{p.description ? <Description text={p.description} /> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {body && (
          <div className="op-docs-body">
            <div className="op-docs-line">
              <span className="mono">Body</span>
              <span className="meta">
                {" "}
                · {body.contentType} · {body.required ? "required" : "optional"}
                {typeLabel(spec.doc, body.schema) && (
                  <>
                    {" "}
                    · <span className="mono">{typeLabel(spec.doc, body.schema)}</span>
                  </>
                )}
              </span>
            </div>
            {body.description && <Description text={body.description} className="op-description" />}
            <SchemaFields doc={spec.doc} schema={body.schema} defaultOpen />
          </div>
        )}
        {op.security && (
          <div className="op-docs-line">
            <span className="mono">Auth</span>
            <span className="meta">
              {" "}
              ·{" "}
              {schemes.length
                ? schemes
                    .map((s) => (s.type ? `${s.name} (${s.scheme ? `${s.type} ${s.scheme}` : s.type})` : s.name))
                    .join(", ")
                : "none"}
            </span>
          </div>
        )}
      </section>

      <section className="op-docs-section" aria-label="Responses">
        <h3 className="label">Responses</h3>
        {!op.responses.length && <p className="meta">The spec declares no responses.</p>}
        {op.responses.map((r) => (
          <div className="op-docs-response" key={r.status}>
            <div className="op-docs-line">
              <span className={`status-badge sm s${statusFamily(r.status)}`}>{r.status}</span>
              <span className="meta">
                {r.contentType ? (
                  <>
                    {r.contentType}
                    {typeLabel(spec.doc, r.schema) && (
                      <>
                        {" "}
                        · <span className="mono">{typeLabel(spec.doc, r.schema)}</span>
                      </>
                    )}
                  </>
                ) : (
                  "no body"
                )}
              </span>
            </div>
            {r.description && <Description text={r.description} className="op-description" />}
            <SchemaFields doc={spec.doc} schema={r.schema} />
          </div>
        ))}
      </section>
    </div>
  );
}
