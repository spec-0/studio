import { useEffect, useMemo, useState } from "react";
import {
  bodyFieldNames,
  bodyModeFor,
  deref,
  typeLabel,
  type Json,
  type OperationSpec,
  type ParsedSpec,
} from "../lib/spec";
import { exampleBody, exampleParam } from "../lib/example";
import { pickAnyFile } from "../lib/store";
import type { AuthState, BodyInput, MultipartPart } from "../lib/request";

interface Props {
  spec: ParsedSpec;
  op: OperationSpec;
  auth: AuthState | null;
  onAuthChange: (auth: AuthState) => void;
  /** Lifted so the send bar (which lives in the frame) can build the request. */
  onValuesChange: (values: RequestValues) => void;
  /** Open the OAuth setup for this API, optionally pre-filled from a declared scheme. */
  onConfigureOAuth?: (schemeName?: string) => void;
  /** One line on whether a usable token is currently held. */
  oauthStatus?: { ok: boolean; label: string } | null;
  /**
   * Values to start from instead of generated examples — set when a recorded
   * request is copied into a new one. Applied once when the operation opens.
   *
   * Path and query values are recovered from the recorded URL; without them the
   * copy would come back with its path fields empty.
   */
  prefill?: {
    headers: Record<string, string>;
    body?: string;
    pathParams?: Record<string, string>;
    queryParams?: Record<string, string>;
    /** Form fields or multipart parts, for an operation that takes them. */
    form?: Array<{ key: string; value: string }>;
    parts?: MultipartPart[];
  } | null;
  /**
   * "step" is a collection step: prefilled headers the operation doesn't
   * declare are shown as editable rows (they are part of the step, not sent
   * unseen), and number fields are plain text so a `{{reference}}` fits.
   */
  mode?: "request" | "step";
}

interface Seed {
  pathParams: Record<string, string>;
  queryParams: Record<string, string>;
  headerParams: Record<string, string>;
  body: string;
  formFields: Array<{ key: string; value: string }>;
  parts: MultipartPart[];
  custom: Array<{ key: string; value: string }>;
}

/** What every input starts from: the prefill where there is one, examples otherwise. */
function seedFor(spec: ParsedSpec, op: OperationSpec, prefill: Props["prefill"], split: boolean): Seed {
  const seed = (where: string) =>
    Object.fromEntries(
      op.parameters
        .filter((p) => p.in === where)
        .map((p) => [p.name, p.required ? exampleParam(spec.doc, p.schema, p.name) : ""]),
    );
  let headerParams = prefill?.headers ?? seed("header");
  let custom: Array<{ key: string; value: string }> = [];
  if (prefill && split) {
    const declared = op.parameters.filter((p) => p.in === "header").map((p) => p.name);
    headerParams = Object.fromEntries(declared.map((name) => [name, ""]));
    for (const [key, value] of Object.entries(prefill.headers)) {
      const match = declared.find((name) => name.toLowerCase() === key.toLowerCase());
      if (match) headerParams[match] = value;
      else custom.push({ key, value });
    }
  }
  // Form fields and multipart parts start from the names the schema declares,
  // so an upload endpoint opens with its parts already listed.
  const declaredFields = bodyFieldNames(spec.doc, op.requestBody?.schema);
  return {
    // A copied recording supplies the values that were actually sent; only fall
    // back to generated examples when there is nothing to start from.
    pathParams: prefill?.pathParams ?? seed("path"),
    queryParams: prefill?.queryParams ?? seed("query"),
    headerParams,
    body: prefill?.body ?? (op.requestBody ? exampleBody(spec.doc, op.requestBody.schema, op.requestBody.media) : ""),
    formFields: prefill?.form ?? declaredFields.map((name) => ({ key: name, value: "" })),
    parts: prefill?.parts ?? declaredFields.map((name) => ({ name, value: "" })),
    custom,
  };
}

export interface RequestValues {
  pathParams: Record<string, string>;
  queryParams: Record<string, string>;
  headerParams: Record<string, string>;
  /** Whatever the declared content type calls for — raw text, fields, or parts. */
  body: BodyInput;
}

/**
 * Operation detail: params typed by their schema, a body pre-populated from the
 * schema (not `"string"` placeholders), and inline JSON validity feedback before
 * the request goes out.
 */
export function OperationView({
  spec,
  op,
  auth,
  onAuthChange,
  onValuesChange,
  prefill,
  onConfigureOAuth,
  oauthStatus,
  mode = "request",
}: Props) {
  const editableExtraHeaders = mode === "step";
  // Seeded before the first render, so the values reported on mount are the
  // real ones rather than a blank form that is filled in a moment later.
  const seeded = useMemo(
    () => seedFor(spec, op, prefill, editableExtraHeaders),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [op, spec.doc, prefill, editableExtraHeaders],
  );
  const [pathParams, setPathParams] = useState<Record<string, string>>(seeded.pathParams);
  const [queryParams, setQueryParams] = useState<Record<string, string>>(seeded.queryParams);
  const [headerParams, setHeaderParams] = useState<Record<string, string>>(seeded.headerParams);
  const [body, setBody] = useState(seeded.body);
  const [formFields, setFormFields] = useState<Array<{ key: string; value: string }>>(seeded.formFields);
  const [parts, setParts] = useState<MultipartPart[]>(seeded.parts);
  const [custom, setCustom] = useState<Array<{ key: string; value: string }>>(seeded.custom);

  /**
   * Which editor to show — decided by the document, not by the user.
   *
   * The spec already says whether this endpoint takes JSON, a form or a file
   * upload. Making someone pick from a dropdown that the schema could have
   * answered is the kind of thing a spec-native client exists not to do.
   */
  const bodyMode = bodyModeFor(op.requestBody?.contentType);

  // Re-seed every input whenever the selected operation changes.
  useEffect(() => {
    setPathParams(seeded.pathParams);
    setQueryParams(seeded.queryParams);
    setHeaderParams(seeded.headerParams);
    setBody(seeded.body);
    setFormFields(seeded.formFields);
    setParts(seeded.parts);
    setCustom(seeded.custom);
  }, [seeded]);

  // Keep the frame's send bar in sync — it owns the base URL and the Send button.
  useEffect(() => {
    // Spec-declared headers first, then anything typed by hand — so a custom row
    // can deliberately override a declared one.
    const merged = { ...headerParams };
    for (const row of custom) if (row.key.trim()) merged[row.key.trim()] = row.value;
    const payload: BodyInput =
      bodyMode === "form"
        ? { kind: "form", fields: formFields }
        : bodyMode === "multipart"
          ? { kind: "multipart", parts }
          : body;
    onValuesChange({ pathParams, queryParams, headerParams: merged, body: payload });
  }, [pathParams, queryParams, headerParams, body, formFields, parts, bodyMode, custom, onValuesChange]);

  const bodyError = useMemo(() => {
    if (!body.trim()) return null;
    try {
      // A step's body can hold {{references}} where values go; they're filled in
      // before sending, so they don't make it invalid here.
      JSON.parse(mode === "step" ? body.replace(/\{\{[^{}]*\}\}/g, "0") : body);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : "Invalid JSON";
    }
  }, [body, mode]);

  const missingRequired = useMemo(() => {
    const missing: string[] = [];
    for (const p of op.parameters) {
      const bag = p.in === "path" ? pathParams : p.in === "query" ? queryParams : headerParams;
      if (p.required && !bag[p.name]) missing.push(p.name);
    }
    return missing;
  }, [op.parameters, pathParams, queryParams, headerParams]);

  const grouped = {
    path: op.parameters.filter((p) => p.in === "path"),
    query: op.parameters.filter((p) => p.in === "query"),
    header: op.parameters.filter((p) => p.in === "header"),
  };

  const setter = (where: "path" | "query" | "header") =>
    where === "path" ? setPathParams : where === "query" ? setQueryParams : setHeaderParams;
  const bag = (where: "path" | "query" | "header") =>
    where === "path" ? pathParams : where === "query" ? queryParams : headerParams;

  return (
    <>
      {/* Method and path live in the address bar above — this header carries the
          human layer: what the operation is for, and whether it's on its way out. */}
      <div className="op-head">
        <div className="op-title">
          <span className="op-summary-text">{op.summary ?? op.operationId ?? "Operation"}</span>
          {op.deprecated && (
            <span className="tag" style={{ color: "hsl(var(--danger))" }}>
              deprecated
            </span>
          )}
        </div>
        {op.operationId && <div className="meta">{op.operationId}</div>}
      </div>

      <div className="op-body">
        {op.description && (
          <div className="section">
            <h3>Description</h3>
            <div style={{ color: "hsl(var(--ink-2))", whiteSpace: "pre-wrap", fontSize: 12.5 }}>
              {op.description}
            </div>
          </div>
        )}

        {(["path", "query", "header"] as const).map((where) =>
          grouped[where].length ? (
            <div className="section" key={where}>
              <h3>{where} parameters</h3>
              {grouped[where].map((p) => {
                const resolved = deref(spec.doc, p.schema);
                const enumValues: unknown[] | undefined = resolved.enum;
                return (
                  <div className="field" key={`${where}:${p.name}`}>
                    <div className="field-label">
                      <div className="field-name">
                        {p.name}
                        {p.required && <span className="required">*</span>}
                      </div>
                      <div className="field-meta">{typeLabel(spec.doc, p.schema)}</div>
                    </div>
                    <div style={{ flex: 1 }}>
                      {enumValues ? (
                        <select
                          value={bag(where)[p.name] ?? ""}
                          onChange={(e) =>
                            setter(where)((prev) => ({ ...prev, [p.name]: e.target.value }))
                          }
                        >
                          <option value="">—</option>
                          {enumValues.map((value) => (
                            <option key={String(value)} value={String(value)}>
                              {String(value)}
                            </option>
                          ))}
                        </select>
                      ) : resolved.type === "boolean" ? (
                        <select
                          value={bag(where)[p.name] ?? ""}
                          onChange={(e) =>
                            setter(where)((prev) => ({ ...prev, [p.name]: e.target.value }))
                          }
                        >
                          <option value="">—</option>
                          <option value="true">true</option>
                          <option value="false">false</option>
                        </select>
                      ) : (
                        <input
                          type={
                            mode === "request" &&
                            (resolved.type === "integer" || resolved.type === "number")
                              ? "number"
                              : "text"
                          }
                          value={bag(where)[p.name] ?? ""}
                          placeholder={p.description ?? ""}
                          onChange={(e) =>
                            setter(where)((prev) => ({ ...prev, [p.name]: e.target.value }))
                          }
                        />
                      )}
                      {p.description && <div className="field-meta">{p.description}</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null,
        )}

        {op.requestBody && (
          <div className="section">
            <h3>
              Request body
              <span className="meta" style={{ marginLeft: 8, textTransform: "none" }}>
                {op.requestBody.contentType}
                {op.requestBody.required ? " · required" : ""}
              </span>
            </h3>
            {bodyMode === "text" ? (
              <>
                <textarea
                  className="editor"
                  value={body}
                  spellCheck={false}
                  onChange={(e) => setBody(e.target.value)}
                />
                <div className="field-meta" style={{ marginTop: 4 }}>
                  {bodyError ? (
                    <span style={{ color: "hsl(var(--danger))" }}>Invalid JSON — {bodyError}</span>
                  ) : (
                    <>Pre-filled from <code>{typeLabel(spec.doc, op.requestBody.schema)}</code>.</>
                  )}
                </div>
              </>
            ) : bodyMode === "form" ? (
              <>
                {formFields.map((row, index) => (
                  <div className="field" key={index}>
                    <div className="field-label">
                      <input
                        value={row.key}
                        placeholder="field"
                        onChange={(e) =>
                          setFormFields((prev) =>
                            prev.map((r, i) => (i === index ? { ...r, key: e.target.value } : r)),
                          )
                        }
                      />
                    </div>
                    <div style={{ flex: 1, display: "flex", gap: 6 }}>
                      <input
                        value={row.value}
                        placeholder="value — {{vars}} work here"
                        onChange={(e) =>
                          setFormFields((prev) =>
                            prev.map((r, i) => (i === index ? { ...r, value: e.target.value } : r)),
                          )
                        }
                      />
                      <button
                        className="btn"
                        style={{ padding: "2px 8px" }}
                        aria-label="Remove field"
                        onClick={() => setFormFields((prev) => prev.filter((_, i) => i !== index))}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                ))}
                <button
                  className="btn"
                  style={{ marginTop: formFields.length ? 8 : 0 }}
                  onClick={() => setFormFields((prev) => [...prev, { key: "", value: "" }])}
                >
                  + Add field
                </button>
                <div className="field-meta" style={{ marginTop: 6 }}>
                  Encoded as <code>application/x-www-form-urlencoded</code>. Repeated keys are kept.
                </div>
              </>
            ) : (
              <>
                {parts.map((part, index) => (
                  <div className="field" key={index}>
                    <div className="field-label">
                      <input
                        value={part.name}
                        placeholder="part"
                        onChange={(e) =>
                          setParts((prev) =>
                            prev.map((p, i) => (i === index ? { ...p, name: e.target.value } : p)),
                          )
                        }
                      />
                    </div>
                    <div style={{ flex: 1, display: "flex", gap: 6 }}>
                      {part.path ? (
                        <span className="part-file mono" title={part.path}>
                          {part.fileName ?? part.path}
                        </span>
                      ) : (
                        <input
                          value={part.value ?? ""}
                          placeholder="value — {{vars}} work here"
                          onChange={(e) =>
                            setParts((prev) =>
                              prev.map((p, i) => (i === index ? { ...p, value: e.target.value } : p)),
                            )
                          }
                        />
                      )}
                      <button
                        className="btn"
                        style={{ whiteSpace: "nowrap" }}
                        onClick={async () => {
                          const picked = await pickAnyFile();
                          if (!picked) return;
                          setParts((prev) =>
                            prev.map((p, i) =>
                              i === index
                                ? { ...p, path: picked.path, fileName: picked.name, value: undefined }
                                : p,
                            ),
                          );
                        }}
                      >
                        {part.path ? "Change" : "File…"}
                      </button>
                      {part.path && (
                        <button
                          className="btn"
                          style={{ padding: "2px 8px" }}
                          title="Send as a text part instead"
                          onClick={() =>
                            setParts((prev) =>
                              prev.map((p, i) =>
                                i === index ? { ...p, path: undefined, fileName: undefined, value: "" } : p,
                              ),
                            )
                          }
                        >
                          ×
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                <button
                  className="btn"
                  style={{ marginTop: parts.length ? 8 : 0 }}
                  onClick={() => setParts((prev) => [...prev, { name: "", value: "" }])}
                >
                  + Add part
                </button>
                <div className="field-meta" style={{ marginTop: 6 }}>
                  Sent as <code>multipart/form-data</code>. The boundary is generated at send time,
                  and files are read from disk rather than held in memory.
                </div>
              </>
            )}
            <BodySchema doc={spec.doc} schema={op.requestBody.schema} />
          </div>
        )}

        {/* Auth is always here, not just when the spec declares securitySchemes.
            A mock, a staging box behind a shared header, or a spec that simply
            omits security all need credentials the document never mentions. */}
        <div className="section">
          <h3>Auth</h3>
          <div className="field">
            <div className="field-label">
              <div className="field-name">scheme</div>
              <div className="field-meta">
                {op.security?.length ? op.security.join(", ") : "none declared"}
              </div>
            </div>
            <div style={{ flex: 1, display: "grid", gap: 6 }}>
              <select
                value={auth?.schemeName ?? ""}
                onChange={(e) => {
                  const picked = e.target.value;
                  const declared = spec.securitySchemes.find((x) => x.name === picked);
                  if (declared) {
                    onAuthChange({
                      schemeName: declared.name,
                      value: declared.type === "oauth2" ? "" : (auth?.value ?? ""),
                      type: declared.type,
                      httpScheme: declared.scheme,
                      in: declared.in,
                      paramName: declared.paramName,
                    });
                    // A declared oauth2 scheme carries its own token URL and
                    // scopes — offer to set it up rather than leaving a text box
                    // the user is expected to paste a token into.
                    if (declared.type === "oauth2") onConfigureOAuth?.(declared.name);
                  } else if (picked === "__bearer") {
                    onAuthChange({ schemeName: picked, value: auth?.value ?? "", type: "http", httpScheme: "bearer" });
                  } else if (picked === "__basic") {
                    onAuthChange({ schemeName: picked, value: auth?.value ?? "", type: "http", httpScheme: "basic" });
                  } else if (picked === "__oauth2") {
                    // The value isn't typed here — it's the acquired access
                    // token, filled in at send time from the token cache.
                    onAuthChange({ schemeName: picked, value: "", type: "oauth2" });
                    onConfigureOAuth?.();
                  } else if (picked === "__header") {
                    onAuthChange({
                      schemeName: picked,
                      value: auth?.value ?? "",
                      type: "apiKey",
                      in: "header",
                      paramName: auth?.paramName || "X-API-Key",
                    });
                  } else {
                    onAuthChange({ schemeName: null, value: "" });
                  }
                }}
              >
                <option value="">None</option>
                {spec.securitySchemes.map((x) => (
                  <option key={x.name} value={x.name}>
                    {x.name} ({x.type}
                    {x.scheme ? ` · ${x.scheme}` : ""}
                    {x.in ? ` · ${x.in}` : ""})
                  </option>
                ))}
                <option value="__bearer">Bearer token</option>
                <option value="__basic">Basic (user:password)</option>
                <option value="__header">API key header</option>
                <option value="__oauth2">OAuth 2.0 — Studio gets the token</option>
              </select>

              {auth?.schemeName === "__header" && (
                <input
                  value={auth.paramName ?? ""}
                  placeholder="Header name, e.g. X-API-Key"
                  onChange={(e) => onAuthChange({ ...auth, paramName: e.target.value })}
                />
              )}

              {auth?.type === "oauth2" && (
                <div className="oauth-status">
                  <span className={oauthStatus?.ok ? "ok-ink" : "meta"}>
                    {oauthStatus?.label ?? "Not configured"}
                  </span>
                  <span className="spacer" />
                  <button className="btn" onClick={() => onConfigureOAuth?.()}>
                    {oauthStatus?.ok ? "Manage" : "Set up"}
                  </button>
                </div>
              )}

              {auth?.schemeName && auth.type !== "oauth2" && (
                <>
                  <input
                    type="password"
                    value={auth.value}
                    placeholder={
                      auth.httpScheme === "basic"
                        ? "user:password"
                        : auth.type === "apiKey"
                          ? `value for ${auth.paramName ?? "the key"}`
                          : "token — or {{token}} from an environment"
                    }
                    onChange={(e) => onAuthChange({ ...auth, value: e.target.value })}
                  />
                  <div className="field-meta">
                    Not stored with the API. Put it in an environment as a secret variable and
                    reference it here as <code>{"{{token}}"}</code>.
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="section">
          <h3>
            Headers
            {custom.length > 0 && <span className="meta"> · {custom.length} custom</span>}
          </h3>
          {custom.map((row, index) => (
            <div className="field" key={index}>
              <div className="field-label">
                <input
                  value={row.key}
                  placeholder="Header"
                  onChange={(e) =>
                    setCustom((prev) =>
                      prev.map((r, i) => (i === index ? { ...r, key: e.target.value } : r)),
                    )
                  }
                />
              </div>
              <div style={{ flex: 1, display: "flex", gap: 6 }}>
                <input
                  value={row.value}
                  placeholder="Value — {{vars}} work here"
                  onChange={(e) =>
                    setCustom((prev) =>
                      prev.map((r, i) => (i === index ? { ...r, value: e.target.value } : r)),
                    )
                  }
                />
                <button
                  className="btn"
                  style={{ padding: "2px 8px" }}
                  onClick={() => setCustom((prev) => prev.filter((_, i) => i !== index))}
                >
                  ×
                </button>
              </div>
            </div>
          ))}
          <button
            className="btn"
            style={{ marginTop: custom.length ? 8 : 0 }}
            onClick={() => setCustom((prev) => [...prev, { key: "", value: "" }])}
          >
            + Add header
          </button>
        </div>

        <div className="section">
          <h3>Responses declared</h3>
          <div>
            {op.responses.map((r) => (
              <span className="chip" key={r.status}>
                {r.status}
                {r.schema ? ` · ${typeLabel(spec.doc, r.schema)}` : " · no schema"}
              </span>
            ))}
          </div>
        </div>

        {missingRequired.length > 0 && (
          <div className="verdict warn" style={{ marginTop: 16 }}>
            <span className="glyph">⚠</span>
            <span>
              Required and still empty: {missingRequired.map((name) => `\`${name}\``).join(", ")}
            </span>
          </div>
        )}
      </div>
    </>
  );
}

/** The schema next to the editor, so you never leave the request to learn the shape. */
function BodySchema({ doc, schema }: { doc: Json; schema: Json | undefined }) {
  const [open, setOpen] = useState(false);
  const resolved = deref(doc, schema);
  const properties = Object.entries<Json>(resolved.properties ?? {});
  if (!properties.length) return null;
  const required: string[] = resolved.required ?? [];

  return (
    <div style={{ marginTop: 10 }}>
      <button className="btn" onClick={() => setOpen((v) => !v)}>
        {open ? "Hide" : "Show"} schema · {properties.length} fields
      </button>
      {open && (
        <table className="fields" style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th>Field</th>
              <th>Type</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {properties.map(([name, prop]) => (
              <tr key={name}>
                <td className="name">
                  {name}
                  {required.includes(name) && <span className="required">*</span>}
                </td>
                <td className="type">{typeLabel(doc, prop)}</td>
                <td className="desc">{deref(doc, prop).description ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
