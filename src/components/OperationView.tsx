import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  bodyModeFor,
  deref,
  typeLabel,
  type OperationSpec,
  type ParsedSpec,
} from "../lib/spec";
import { seedEditor, type EditorPrefill, type EditorState } from "../lib/editor";
import { pickAnyFile } from "../lib/store";
import type { AuthState, BodyInput, MultipartPart } from "../lib/request";
import type { LinkTarget } from "../lib/chainLinks";
import { Description } from "./Description";
import { descriptionText } from "../lib/markdown";
import { AlignLeft, Plus, RotateCcw, X } from "lucide-react";
import { CodeEditor } from "./CodeEditor";
import { SchemaFields } from "./SchemaFields";
import { OperationDocs } from "./OperationDocs";
import { TabList } from "./TabList";

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
   * Values to start from instead of generated examples, set when a recorded
   * request is copied into a new one. Applied once when the operation opens.
   *
   * Path and query values are recovered from the recorded URL; without them the
   * copy would come back with its path fields empty.
   */
  prefill?: EditorPrefill | null;
  /**
   * Unsent changes from an earlier visit, restored exactly as they were left.
   * Takes the place of both the prefill and the examples. Applied when the
   * operation opens; the caller remounts the editor to apply another one.
   */
  draft?: EditorState | null;
  /** Every change to the fields, as they are on screen, so a draft can keep them. */
  onEditorChange?: (state: EditorState) => void;
  /**
   * Shown when the fields differ from what was last sent (or from the spec's
   * examples, if nothing was sent): a marker, and a way back to the examples.
   */
  unsent?: { onDiscard: () => void } | null;
  /**
   * "step" is a collection step: prefilled headers the operation doesn't
   * declare are shown as editable rows (they are part of the step, not sent
   * unseen), and number fields are plain text so a `{{reference}}` fits.
   */
  mode?: "request" | "step";
  /**
   * In a collection step: wraps the control of each field that can take a value
   * from an earlier step, to show its link (or a way to add one) instead.
   */
  linkSlot?: (target: LinkTarget, value: string, control: ReactNode) => ReactNode;
  /** In a collection step: shown under the body editor, e.g. the body fields that are linked. */
  bodyExtra?: ReactNode;
  /**
   * In a collection step: one more tab after Docs (the last response), whose
   * selection the step keeps. The step's own header names it, so the
   * operation's title isn't repeated.
   */
  extraTab?: { label: ReactNode; content: ReactNode; active: boolean; onActive: (active: boolean) => void };
}

export interface RequestValues {
  pathParams: Record<string, string>;
  queryParams: Record<string, string>;
  headerParams: Record<string, string>;
  /** Whatever the declared content type calls for: raw text, fields, or parts. */
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
  draft,
  onEditorChange,
  unsent,
  linkSlot,
  bodyExtra,
  extraTab,
}: Props) {
  const slot = (target: LinkTarget, value: string, control: ReactNode) =>
    linkSlot ? linkSlot(target, value, control) : control;
  const editableExtraHeaders = mode === "step";
  // Seeded before the first render, so the values reported on mount are the
  // real ones rather than a blank form that is filled in a moment later.
  const seeded = useMemo(
    () => draft ?? seedEditor(spec, op, prefill, editableExtraHeaders),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [op, spec.doc, prefill, draft, editableExtraHeaders],
  );
  const [pathParams, setPathParams] = useState<Record<string, string>>(seeded.pathParams);
  const [queryParams, setQueryParams] = useState<Record<string, string>>(seeded.queryParams);
  const [headerParams, setHeaderParams] = useState<Record<string, string>>(seeded.headerParams);
  const [body, setBody] = useState(seeded.body);
  const [formFields, setFormFields] = useState<Array<{ key: string; value: string }>>(seeded.formFields);
  const [parts, setParts] = useState<MultipartPart[]>(seeded.parts);
  const [custom, setCustom] = useState<Array<{ key: string; value: string }>>(seeded.custom);

  /**
   * Which editor to show. The document decides, not the user.
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

  // Keep the frame's send bar in sync: it owns the base URL and the Send button.
  useEffect(() => {
    // Spec-declared headers first, then anything typed by hand, so a custom row
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
    onEditorChange?.({ pathParams, queryParams, headerParams, body, formFields, parts, custom });
  }, [pathParams, queryParams, headerParams, body, formFields, parts, bodyMode, custom, onValuesChange, onEditorChange]);

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

  // Which section is on screen. Opening an operation goes to the first one
  // that needs input; after that, the choice is remembered for the session.
  const tabKey = `${spec.title}|${op.id}`;
  const firstTab = (): RequestTab =>
    op.parameters.some((p) => p.in === "path" && p.required)
      ? "params"
      : op.requestBody
        ? "body"
        : "params";
  const [tab, setTabState] = useState<RequestTab>(() => chosenTabs.get(tabKey) ?? firstTab());
  useEffect(() => setTabState(chosenTabs.get(tabKey) ?? firstTab()), [tabKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const setTab = (next: RequestTab) => {
    chosenTabs.set(tabKey, next);
    setTabState(next);
  };

  const paramCount = grouped.path.length + grouped.query.length;
  const headerCount = grouped.header.length + custom.filter((row) => row.key.trim()).length;
  const authLabel = auth?.schemeName
    ? auth.type === "oauth2"
      ? "OAuth 2"
      : auth.httpScheme === "basic"
        ? "basic"
        : auth.type === "apiKey"
          ? "key"
          : "bearer"
    : "none";
  const summaryLine = op.description ? descriptionText(op.description).split(/(?<=[.!?])\s/)[0] : "";
  const exampleBody = () => seedEditor(spec, op, null, editableExtraHeaders).body;

  const tabs: Array<{ id: RequestTab; label: ReactNode }> = [
    ...(op.requestBody
      ? [
          {
            id: "body" as const,
            label: (
              <>
                Body{op.requestBody.required && <span className="req-dot" aria-label="required" />}
              </>
            ),
          },
        ]
      : []),
    { id: "params", label: <>Params <span className="c">{paramCount}</span></> },
    { id: "headers", label: <>Headers <span className="c">{headerCount}</span></> },
    { id: "auth", label: <>Auth <span className="c">{authLabel}</span></> },
    { id: "docs", label: "Docs" },
    ...(extraTab ? [{ id: "extra" as const, label: extraTab.label }] : []),
  ];
  const shown: RequestTab = extraTab?.active ? "extra" : tab === "body" && !op.requestBody ? "params" : tab;
  const selectTab = (next: RequestTab) => {
    if (next === "extra") return extraTab?.onActive(true);
    extraTab?.onActive(false);
    setTab(next);
  };

  const paramRows = (where: "path" | "query" | "header") =>
    grouped[where].map((p) => {
      const resolved = deref(spec.doc, p.schema);
      const enumValues: unknown[] | undefined = resolved.enum;
      return (
        <div className="field" key={`${where}:${p.name}`}>
          <div className="field-label">
            <div className="field-name">
              {p.name}
              {p.required && <span className="required-word">required</span>}
            </div>
            <div className="field-meta">
              {where === "path" ? "path" : where === "query" ? "query" : "header"} · {typeLabel(spec.doc, p.schema)}
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            {slot({ in: where, name: p.name }, bag(where)[p.name] ?? "", enumValues ? (
              <select
                value={bag(where)[p.name] ?? ""}
                onChange={(e) => setter(where)((prev) => ({ ...prev, [p.name]: e.target.value }))}
              >
                <option value="">–</option>
                {enumValues.map((value) => (
                  <option key={String(value)} value={String(value)}>
                    {String(value)}
                  </option>
                ))}
              </select>
            ) : resolved.type === "boolean" ? (
              <select
                value={bag(where)[p.name] ?? ""}
                onChange={(e) => setter(where)((prev) => ({ ...prev, [p.name]: e.target.value }))}
              >
                <option value="">–</option>
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : (
              <input
                type={mode === "request" && (resolved.type === "integer" || resolved.type === "number") ? "number" : "text"}
                value={bag(where)[p.name] ?? ""}
                placeholder={p.description ? descriptionText(p.description) : ""}
                onChange={(e) => setter(where)((prev) => ({ ...prev, [p.name]: e.target.value }))}
              />
            ))}
            {p.description && <Description text={p.description} className="field-meta" />}
          </div>
        </div>
      );
    });

  return (
    <>
      {/* Method and path live in the address bar above. This header carries the
          human layer: what the operation is for, and whether it's on its way out. */}
      {mode !== "step" && (
      <div className="op-head">
        <div className="op-title">
          <span className="op-summary-text">{op.summary ?? op.operationId ?? "Operation"}</span>
          {op.deprecated && <span className="chip sans bad">Deprecated</span>}
          {unsent && (
            <span className="unsent-note">
              <span className="dirty-dot" aria-hidden="true" />
              Unsent changes
              <button
                type="button"
                className="btn ghost sm"
                onClick={unsent.onDiscard}
                title="Go back to the values the spec suggests"
              >
                Discard changes
              </button>
            </span>
          )}
        </div>
        {(op.operationId || summaryLine) && (
          <div className="op-sub">
            {op.operationId && <span className="mono">{op.operationId}</span>}
            {op.operationId && summaryLine && <span aria-hidden> · </span>}
            {summaryLine && <span className="op-sub-text">{summaryLine}</span>}
          </div>
        )}
      </div>
      )}

      <TabList<RequestTab>
        className="ptabs request-tabs-list"
        tabClassName="ptab"
        label="Request"
        tabs={tabs}
        selected={shown}
        onSelect={selectTab}
      />

      <div className="op-body">
        {shown === "body" && op.requestBody && (
          <div className="tab-pane">
            {bodyMode === "text" ? (
              <>
                <div className="pane-toolbar">
                  <span className="mono">{op.requestBody.contentType}</span>
                  {op.requestBody.required && <span>· required</span>}
                  {typeLabel(spec.doc, op.requestBody.schema) && (
                    <span>
                      · from <span className="mono">{typeLabel(spec.doc, op.requestBody.schema)}</span> example
                    </span>
                  )}
                  <span className="spacer" />
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={Boolean(bodyError) || !body.trim()}
                    title={bodyError ? "Fix the JSON first" : "Indent the JSON"}
                    onClick={() => {
                      try {
                        setBody(JSON.stringify(JSON.parse(body), null, 2));
                      } catch {
                        /* not JSON: nothing to format */
                      }
                    }}
                  >
                    <AlignLeft size={13} /> Format
                  </button>
                  <button
                    type="button"
                    className="btn ghost sm"
                    title="Replace the body with the spec's example"
                    onClick={() => setBody(exampleBody())}
                  >
                    <RotateCcw size={13} /> Reset to example
                  </button>
                </div>
                <CodeEditor value={body} onChange={setBody} label="Request body" />
                {bodyError && (
                  <div className="field-meta" style={{ marginTop: 6, color: "hsl(var(--danger))" }}>
                    Invalid JSON: {bodyError}
                  </div>
                )}
              </>
            ) : bodyMode === "form" ? (
              <>
                <div className="pane-toolbar">
                  <span className="mono">application/x-www-form-urlencoded</span>
                  <span>· repeated keys are kept</span>
                </div>
                {formFields.map((row, index) => (
                  <div className="field" key={index}>
                    <div className="field-label">
                      <input
                        value={row.key}
                        placeholder="field"
                        onChange={(e) =>
                          setFormFields((prev) => prev.map((r, i) => (i === index ? { ...r, key: e.target.value } : r)))
                        }
                      />
                    </div>
                    <div style={{ flex: 1, display: "flex", gap: 6, minWidth: 0 }}>
                      {slot({ in: "form", name: row.key }, row.value, (
                        <input
                          value={row.value}
                          placeholder="value ({{vars}} work here)"
                          onChange={(e) =>
                            setFormFields((prev) =>
                              prev.map((r, i) => (i === index ? { ...r, value: e.target.value } : r)),
                            )
                          }
                        />
                      ))}
                      <button
                        className="icon-btn"
                        aria-label="Remove field"
                        title="Remove field"
                        onClick={() => setFormFields((prev) => prev.filter((_, i) => i !== index))}
                      >
                        <X size={13} />
                      </button>
                    </div>
                  </div>
                ))}
                <button
                  className="btn"
                  style={{ marginTop: formFields.length ? 8 : 0 }}
                  onClick={() => setFormFields((prev) => [...prev, { key: "", value: "" }])}
                >
                  <Plus size={13} /> Add field
                </button>
              </>
            ) : (
              <>
                <div className="pane-toolbar">
                  <span className="mono">multipart/form-data</span>
                  <span>· files are read from disk when it's sent</span>
                </div>
                {parts.map((part, index) => (
                  <div className="field" key={index}>
                    <div className="field-label">
                      <input
                        value={part.name}
                        placeholder="part"
                        onChange={(e) =>
                          setParts((prev) => prev.map((p, i) => (i === index ? { ...p, name: e.target.value } : p)))
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
                          placeholder="value ({{vars}} work here)"
                          onChange={(e) =>
                            setParts((prev) => prev.map((p, i) => (i === index ? { ...p, value: e.target.value } : p)))
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
                              i === index ? { ...p, path: picked.path, fileName: picked.name, value: undefined } : p,
                            ),
                          );
                        }}
                      >
                        {part.path ? "Change" : "File…"}
                      </button>
                      {part.path && (
                        <button
                          className="icon-btn"
                          aria-label="Send as a text part instead"
                          title="Send as a text part instead"
                          onClick={() =>
                            setParts((prev) =>
                              prev.map((p, i) => (i === index ? { ...p, path: undefined, fileName: undefined, value: "" } : p)),
                            )
                          }
                        >
                          <X size={13} />
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
                  <Plus size={13} /> Add part
                </button>
              </>
            )}
            {bodyExtra}
            <SchemaFields doc={spec.doc} schema={op.requestBody.schema} />
          </div>
        )}

        {shown === "params" && (
          <div className="tab-pane">
            {paramCount === 0 ? (
              <p className="meta">This operation takes no path or query parameters.</p>
            ) : (
              <>
                {paramRows("path")}
                {paramRows("query")}
              </>
            )}
          </div>
        )}

        {shown === "headers" && (
          <div className="tab-pane">
            {paramRows("header")}
            {op.requestBody?.contentType && bodyMode === "text" && (
              <div className="field derived">
                <div className="field-label">
                  <div className="field-name">Content-Type</div>
                  <div className="field-meta">from the body</div>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <input value={op.requestBody.contentType} disabled aria-label="Content-Type, set from the body" />
                </div>
              </div>
            )}
            {custom.map((row, index) => (
              <div className="field" key={index}>
                <div className="field-label">
                  <input
                    value={row.key}
                    placeholder="Header"
                    onChange={(e) =>
                      setCustom((prev) => prev.map((r, i) => (i === index ? { ...r, key: e.target.value } : r)))
                    }
                  />
                </div>
                <div style={{ flex: 1, display: "flex", gap: 6, minWidth: 0 }}>
                  {slot({ in: "header", name: row.key.trim() }, row.value, (
                    <input
                      value={row.value}
                      placeholder="Value ({{vars}} work here)"
                      onChange={(e) =>
                        setCustom((prev) => prev.map((r, i) => (i === index ? { ...r, value: e.target.value } : r)))
                      }
                    />
                  ))}
                  <button
                    className="icon-btn"
                    aria-label="Remove header"
                    title="Remove header"
                    onClick={() => setCustom((prev) => prev.filter((_, i) => i !== index))}
                  >
                    <X size={13} />
                  </button>
                </div>
              </div>
            ))}
            <button
              className="btn"
              style={{ marginTop: 8 }}
              onClick={() => setCustom((prev) => [...prev, { key: "", value: "" }])}
            >
              <Plus size={13} /> Add header
            </button>
            <p className="meta" style={{ marginTop: 10 }}>
              Secrets go in an environment, as <span className="mono">{"{{name}}"}</span>, not here.
            </p>
          </div>
        )}

        {shown === "auth" && (
          <div className="tab-pane">
            {/* Auth is always here, not just when the spec declares securitySchemes.
                A mock, a staging box behind a shared header, or a spec that simply
                omits security all need credentials the document never mentions. */}
            <div className="field">
              <div className="field-label">
                <div className="field-label-text">Scheme</div>
                <div className="field-meta">
                  {op.security?.length ? `the spec asks for ${op.security.join(", ")}` : "none declared"}
                </div>
              </div>
              <div style={{ flex: 1, display: "grid", gap: 6, maxWidth: 420 }}>
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
                      // scopes, so offer to set it up rather than leaving a text box
                      // the user is expected to paste a token into.
                      if (declared.type === "oauth2") onConfigureOAuth?.(declared.name);
                    } else if (picked === "__bearer") {
                      onAuthChange({ schemeName: picked, value: auth?.value ?? "", type: "http", httpScheme: "bearer" });
                    } else if (picked === "__basic") {
                      onAuthChange({ schemeName: picked, value: auth?.value ?? "", type: "http", httpScheme: "basic" });
                    } else if (picked === "__oauth2") {
                      // The value isn't typed here. It's the acquired access
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
                  <option value="__oauth2">OAuth 2.0 (Studio gets the token)</option>
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
                    <span className={oauthStatus?.ok ? "ok-ink" : "meta"}>{oauthStatus?.label ?? "Not configured"}</span>
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
                            : "token, or {{token}} from an environment"
                      }
                      onChange={(e) => onAuthChange({ ...auth, value: e.target.value })}
                    />
                    <div className="field-meta">
                      Not stored with the API. Put it in an environment as a secret variable and reference it here as{" "}
                      <code>{"{{token}}"}</code>.
                    </div>
                  </>
                )}
              </div>
            </div>
            {!spec.securitySchemes.length && (
              <p className="meta" style={{ marginTop: 6 }}>
                This API declares no auth scheme. Pick one above if the server needs it anyway.
              </p>
            )}
          </div>
        )}

        {shown === "extra" && extraTab?.content}

        {shown === "docs" && <OperationDocs spec={spec} op={op} />}

        {missingRequired.length > 0 && (
          <div className="verdict warn" style={{ marginTop: 16 }}>
            <span className="glyph">⚠</span>
            <span>Required and still empty: {missingRequired.map((name) => `\`${name}\``).join(", ")}</span>
          </div>
        )}
      </div>
    </>
  );
}

type RequestTab = "body" | "params" | "headers" | "auth" | "docs" | "extra";

/** The section chosen for each operation, for the session. */
const chosenTabs = new Map<string, RequestTab>();

