import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Link2, Link2Off, Trash2 } from "lucide-react";
import type { CollectionStep, StepTarget } from "../../lib/collection";
import {
  describeTarget,
  inputsFromEditor,
  sameInputs,
  targetOptions,
  type StepLink,
} from "../../lib/collectionLink";
import type { StepResult } from "../../lib/collectionRun";
import { SCRATCH_METHODS } from "../../lib/scratch";
import { authOf, stepAuthOf } from "../../hooks/useCollections";
import { OperationView, type RequestValues } from "../OperationView";
import { TabList } from "../TabList";
import { insertInto, isInsertable, type Insertable } from "./insert";
import { StepResponse } from "./StepResponse";
import { ValuePicker, type EarlierStep } from "./ValuePicker";

export type StepTab = "request" | "response";

interface Props {
  step: CollectionStep;
  index: number;
  total: number;
  link: StepLink;
  /** The hosted mock for the step's API, when it has one. */
  mockUrl: string | null;
  earlier: EarlierStep[];
  result: StepResult | undefined;
  running: boolean;
  tab: StepTab;
  onTab: (tab: StepTab) => void;
  /** Changes the editor makes to the step. */
  onChange: (change: (step: CollectionStep) => CollectionStep) => void;
  /** Rename the key; returns a problem to show, or null. */
  onRenameKey: (to: string) => string | null;
  onRemove: () => void;
  onLink: () => void;
  /** A reference waiting for the user to click the field it goes into. */
  pendingInsert: string | null;
  onInserted: () => void;
  /** A value clicked in this step's response, to use in a later step. */
  onPickFromResponse: (reference: string, anchor: DOMRect) => void;
  /** Copy a reference when there's no field to put it in. */
  onCopied: (reference: string) => void;
  /** Changes whenever the step is replaced from outside the editor, e.g. reloaded from its file. */
  revision: number;
}

const targetValue = (target: StepTarget | undefined) =>
  !target ? "" : target.kind === "server" ? `server:${target.url}` : target.kind;

/**
 * One step: where it goes, its inputs (the operation editor, reused), and the
 * last run's response.
 */
export function StepEditor({
  step,
  index,
  total,
  link,
  mockUrl,
  earlier,
  result,
  running,
  tab,
  onTab,
  onChange,
  onRenameKey,
  onRemove,
  onLink,
  pendingInsert,
  onInserted,
  onPickFromResponse,
  onCopied,
  revision,
}: Props) {
  const [keyDraft, setKeyDraft] = useState(step.key);
  const [keyError, setKeyError] = useState<string | null>(null);
  useEffect(() => {
    setKeyDraft(step.key);
    setKeyError(null);
  }, [step.key]);

  const linked = link.kind === "ok" || link.kind === "stale" ? link : null;
  const spec = linked?.spec ?? (link.kind === "unresolved" ? (link.spec ?? null) : null);
  const options = useMemo(() => targetOptions(spec, mockUrl), [spec, mockUrl]);

  // ── putting a reference into a field ───────────────────────────────────────
  const area = useRef<HTMLDivElement>(null);
  const lastField = useRef<Insertable | null>(null);
  const pending = useRef(pendingInsert);
  pending.current = pendingInsert;
  useEffect(() => {
    const node = area.current;
    if (!node) return;
    const onFocus = (event: FocusEvent) => {
      const target = event.target;
      if (!isInsertable(target) || target.closest("[data-no-insert]") || target.hasAttribute("data-no-insert")) return;
      lastField.current = target;
      if (pending.current) {
        insertInto(target, pending.current);
        onInserted();
      }
    };
    node.addEventListener("focusin", onFocus);
    return () => node.removeEventListener("focusin", onFocus);
  }, [onInserted, tab]);

  const pick = (reference: string) => {
    const field = lastField.current;
    if (field && document.body.contains(field)) insertInto(field, reference);
    else onCopied(reference);
  };

  // ── the operation editor's values → the step ───────────────────────────────
  const stepRef = useRef(step);
  stepRef.current = step;
  const onValuesChange = useCallback(
    (values: RequestValues) => {
      if (!linked) return;
      const inputs = inputsFromEditor(linked.op, values, stepRef.current);
      if (sameInputs(stepRef.current, inputs)) return;
      onChange((current) => {
        const { body: _body, ...rest } = current;
        return { ...rest, ...inputs };
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [linked?.op, onChange],
  );

  const editorKey = `${step.key}:${linked?.op.id ?? ""}:${revision}`;
  const prefill = useMemo(
    () => ({
      pathParams: step.pathParams,
      queryParams: step.queryParams,
      headers: step.headers,
      body: typeof step.body === "string" ? step.body : "",
      ...(step.body && typeof step.body !== "string" && step.body.kind === "form" ? { form: step.body.fields } : {}),
      ...(step.body && typeof step.body !== "string" && step.body.kind === "multipart" ? { parts: step.body.parts } : {}),
    }),
    // Only when a different step (or a reloaded one) is shown: the editor owns
    // its fields while it's open, and re-seeding on every keystroke would fight it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editorKey],
  );

  const method = (step.operation?.method ?? step.request?.method ?? "GET").toUpperCase();

  return (
    <section className="step-editor" aria-label={`Step ${index + 1} of ${total}`}>
      <header className="step-head">
        <div className="step-head-row">
          <span className={`method-chip ${method.toLowerCase()}`}>{method}</span>
          <span className="step-head-path mono">{step.operation?.path ?? step.request?.url}</span>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onLink}>
            <Link2 size={13} aria-hidden />
            {step.api ? "Link to another operation…" : "Link to an operation…"}
          </button>
          <button type="button" className="icon-btn danger" aria-label={`Remove step ${step.key}`} title="Remove step" onClick={onRemove}>
            <Trash2 size={14} />
          </button>
        </div>
        <div className="step-head-fields">
          <label className="step-field">
            <span className="field-meta">Key, for {"{{steps."}{step.key}{".…}}"}</span>
            <input
              className="mono"
              value={keyDraft}
              aria-invalid={Boolean(keyError)}
              data-no-insert
              onChange={(event) => setKeyDraft(event.target.value)}
              onBlur={(event) => {
                const next = event.currentTarget.value.trim();
                if (next === step.key) return;
                const problem = onRenameKey(next);
                setKeyError(problem);
                if (problem) setKeyDraft(step.key);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") (event.target as HTMLInputElement).blur();
              }}
            />
          </label>
          <label className="step-field">
            <span className="field-meta">Name</span>
            <input
              value={step.name ?? ""}
              placeholder={linked?.op.summary ?? "Optional"}
              data-no-insert
              onChange={(event) => {
                const name = event.target.value;
                onChange(({ name: _old, ...rest }) => (name ? { ...rest, name } : rest));
              }}
            />
          </label>
          {step.api && (
            <label className="step-field grow">
              <span className="field-meta">Send to</span>
              <select
                value={targetValue(step.target)}
                data-no-insert
                onChange={(event) => {
                  const value = event.target.value;
                  const target: StepTarget | undefined =
                    value === ""
                      ? undefined
                      : value === "mock"
                        ? { kind: "mock" }
                        : value === "local-mock"
                          ? { kind: "local-mock" }
                          : value === "custom"
                            ? { kind: "custom", url: step.target?.kind === "custom" ? step.target.url : "" }
                            : { kind: "server", url: value.slice("server:".length) };
                  onChange(({ target: _old, ...rest }) => (target ? { ...rest, target } : rest));
                }}
              >
                <option value="">{describeTarget(undefined, spec)}</option>
                {options
                  .filter((o) => !(o.target.kind === "server" && o.target.url === spec?.servers[0]))
                  .map((option) => (
                    <option key={targetValue(option.target)} value={targetValue(option.target)}>
                      {option.label}
                    </option>
                  ))}
                {step.target?.kind === "server" && !spec?.servers.includes(step.target.url) && (
                  <option value={targetValue(step.target)}>{step.target.url} (no longer declared)</option>
                )}
                {step.target?.kind === "mock" && !mockUrl && <option value="mock">Hosted mock (none for this API)</option>}
                {step.target?.kind === "local-mock" && <option value="local-mock">Local mock</option>}
                <option value="custom">Custom URL…</option>
              </select>
            </label>
          )}
          {step.target?.kind === "custom" && (
            <label className="step-field grow">
              <span className="field-meta">URL</span>
              <input
                className="mono"
                value={step.target.url}
                placeholder="https://… or {{baseUrl}}"
                data-no-insert
                onChange={(event) => {
                  const url = event.target.value;
                  onChange((current) => ({ ...current, target: { kind: "custom", url } }));
                }}
              />
            </label>
          )}
        </div>
        {keyError && <div className="field-meta danger-ink">{keyError}</div>}
      </header>

      {link.kind === "stale" && (
        <div className="verdict warn step-banner" role="note">
          <AlertTriangle size={14} aria-hidden className="glyph" />
          <div>
            <strong>The spec changed since this step was made.</strong>
            <ul>
              {link.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {link.kind === "unresolved" && (
        <div className="verdict warn step-banner danger" role="note">
          <Link2Off size={14} aria-hidden className="glyph" />
          <div>
            <strong>{link.reason}</strong>
            <div>
              <button type="button" className="btn" onClick={onLink}>
                Link to an operation…
              </button>
            </div>
          </div>
        </div>
      )}
      {link.kind === "unlinked" && (
        <div className="verdict none step-banner" role="note">
          <span className="glyph">i</span>
          <span>
            This request isn't linked to an operation, so its response isn't checked. Link it to one to check it
            against the spec.
          </span>
        </div>
      )}

      <TabList<StepTab>
        className="tabs step-tabs"
        tabClassName="tab"
        label="Step"
        tabs={[
          { id: "request", label: "Request" },
          {
            id: "response",
            label: (
              <>
                Response
                {result && (
                  <span className={`run-dot ${result.verdict}`} aria-label={result.verdict === "pass" ? "passed" : result.verdict === "fail" ? "failed" : "not run"} />
                )}
              </>
            ),
          },
        ]}
        selected={tab}
        onSelect={onTab}
      />

      <div className="step-body" ref={area}>
        {pendingInsert && tab === "request" && (
          <div className="verdict none pending-insert" role="status">
            <span className="glyph">→</span>
            <span>
              Click the field to fill with <code>{pendingInsert}</code>
            </span>
            <span className="spacer" />
            <button type="button" className="btn ghost" onClick={onInserted} data-no-insert>
              Cancel
            </button>
          </div>
        )}
        {tab === "response" ? (
          <StepResponse stepKey={step.key} result={result} running={running} onPick={onPickFromResponse} />
        ) : (
          <>
            <ValuePicker steps={earlier} onPick={pick} />
            {linked ? (
              <div className="step-operation">
                <OperationView
                  key={editorKey}
                  spec={linked.spec}
                  op={linked.op}
                  auth={authOf(step)}
                  onAuthChange={(auth) =>
                    onChange(({ auth: _old, ...rest }) => {
                      const next = stepAuthOf(auth);
                      return next ? { ...rest, auth: next } : rest;
                    })
                  }
                  onValuesChange={onValuesChange}
                  prefill={prefill}
                  mode="step"
                />
              </div>
            ) : (
              <PlainStepEditor key={`${step.key}:${revision}`} step={step} onChange={onChange} unlinked={link.kind === "unlinked"} />
            )}
          </>
        )}
      </div>
    </section>
  );
}

/**
 * The inputs of a step with no operation to edit them against: an unlinked
 * request, or a step whose operation is gone. Nothing is thrown away while it
 * waits to be linked.
 */
function PlainStepEditor({
  step,
  onChange,
  unlinked,
}: {
  step: CollectionStep;
  onChange: (change: (step: CollectionStep) => CollectionStep) => void;
  unlinked: boolean;
}) {
  const rows = (
    label: string,
    field: "pathParams" | "queryParams" | "headers",
  ) => {
    const entries = Object.entries(step[field]);
    const set = (next: Array<[string, string]>) =>
      onChange((current) => ({ ...current, [field]: Object.fromEntries(next) }));
    if (!entries.length && field !== "headers") return null;
    return (
      <div className="section">
        <h3>{label}</h3>
        {entries.map(([name, value], i) => (
          <div className="field" key={i}>
            <div className="field-label">
              <input
                value={name}
                aria-label={`${label} name`}
                onChange={(event) => set(entries.map((e, j) => (j === i ? [event.target.value, e[1]] : e)))}
              />
            </div>
            <div style={{ flex: 1, display: "flex", gap: 6 }}>
              <input
                value={value}
                aria-label={`${name} value`}
                onChange={(event) => set(entries.map((e, j) => (j === i ? [e[0], event.target.value] : e)))}
              />
              <button type="button" className="btn" aria-label={`Remove ${name}`} onClick={() => set(entries.filter((_, j) => j !== i))}>
                ×
              </button>
            </div>
          </div>
        ))}
        {field === "headers" && (
          <button type="button" className="btn" onClick={() => set([...entries, ["", ""]])}>
            + Add header
          </button>
        )}
      </div>
    );
  };
  return (
    <div className="op-body">
      {unlinked && step.request && (
        <div className="section">
          <h3>Request</h3>
          <div className="field">
            <div className="field-label">
              <select
                aria-label="Method"
                value={step.request.method.toUpperCase()}
                onChange={(event) => {
                  const method = event.target.value;
                  onChange((current) => ({ ...current, request: { ...current.request!, method } }));
                }}
              >
                {SCRATCH_METHODS.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </div>
            <input
              className="mono"
              aria-label="URL"
              value={step.request.url}
              onChange={(event) => {
                const url = event.target.value;
                onChange((current) => ({ ...current, request: { ...current.request!, url } }));
              }}
            />
          </div>
        </div>
      )}
      {rows("Path parameters", "pathParams")}
      {rows("Query parameters", "queryParams")}
      {rows("Headers", "headers")}
      {(unlinked || typeof step.body === "string") && (
        <div className="section">
          <h3>Body</h3>
          <textarea
            className="editor"
            spellCheck={false}
            aria-label="Body"
            value={typeof step.body === "string" ? step.body : ""}
            onChange={(event) => {
              const body = event.target.value;
              onChange(({ body: _old, ...rest }) => (body ? { ...rest, body } : rest));
            }}
          />
        </div>
      )}
    </div>
  );
}
