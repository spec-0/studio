import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Link2, X } from "lucide-react";
import { parsePath, type PathSegment, type PickableField } from "../../lib/chain";
import {
  describeLinkTarget,
  describeSourcePath,
  parseBodyPath,
  sameTarget,
  targetId,
  type ChainLink,
  type LinkableField,
  type LinkSource,
  type LinkTarget,
} from "../../lib/chainLinks";
import type { Collection } from "../../lib/collection";
import { redact } from "../../lib/redact";

/** What an earlier step offers to link from. */
export interface StepFields {
  key: string;
  index: number;
  title: string;
  method: string;
  path: string;
  fields: PickableField[];
  /** Where the fields came from: the last run's response, or the declared schema. */
  from: "response" | "schema" | "none";
}

/** The fields of a step a link can fill. */
export interface StepTargets {
  fields: LinkableField[];
  /** Why body fields can't be offered, e.g. the body isn't valid JSON. */
  bodyProblem: string | null;
  /** Whether a typed body path should be written bare, by the spec's type for it. */
  bareFor: (path: PathSegment[]) => boolean;
  /** The operation takes a JSON (or text) body, so a body field can be typed in. */
  takesBody: boolean;
}

export interface LinkDraft {
  targetIndex: number;
  target?: LinkTarget;
  source?: LinkSource;
  /** The link being changed, when this edits one. */
  editing?: ChainLink;
}

interface Props {
  collection: Collection;
  steps: StepFields[];
  targetsFor: (index: number) => StepTargets;
  initial: LinkDraft;
  /** Save; returns a problem to show, or null when it's done. */
  onSave: (next: { targetIndex: number; target: LinkTarget; source: LinkSource; bare: boolean }, editing?: ChainLink) => string | null;
  onClose: () => void;
}

const shorten = (text: string, max = 40) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * Adding or changing a link: which field of which step to fill (left), and
 * which value from an earlier step's response to fill it with (right). The
 * sentence at the bottom says what will happen before anything does.
 */
export function LinkDialog({ collection, steps, targetsFor, initial, onSave, onClose }: Props) {
  const [targetIndex, setTargetIndex] = useState(initial.targetIndex);
  const [target, setTarget] = useState<LinkTarget | undefined>(initial.target);
  const [sourceKey, setSourceKey] = useState<string | undefined>(
    initial.source?.step ?? steps[Math.max(0, initial.targetIndex - 1)]?.key,
  );
  const [sourcePath, setSourcePath] = useState<PathSegment[] | undefined>(initial.source?.path);
  const [filter, setFilter] = useState("");
  const [typedField, setTypedField] = useState("");
  const [typedHeader, setTypedHeader] = useState("");
  const [typedSource, setTypedSource] = useState("");
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLSelectElement>(null);
  useEffect(() => first.current?.focus(), []);

  const targets = useMemo(() => targetsFor(targetIndex), [targetsFor, targetIndex]);
  const earlier = steps.filter((s) => s.index < targetIndex);
  const source = steps.find((s) => s.key === sourceKey && s.index < targetIndex) ?? null;
  const targetStep = collection.steps[targetIndex];
  const targetTitle = targetStep ? targetStep.name || targetStep.key : "";

  // A different target step: the old field may not exist there, and the source must be earlier.
  const changeTargetStep = (index: number) => {
    setTargetIndex(index);
    const nextTargets = targetsFor(index);
    if (target && !nextTargets.fields.some((f) => sameTarget(f.target, target))) setTarget(undefined);
    if (!steps.some((s) => s.key === sourceKey && s.index < index)) {
      setSourceKey(steps[index - 1]?.key);
      setSourcePath(undefined);
    }
  };

  const groups = useMemo(() => {
    const out = new Map<string, LinkableField[]>();
    for (const field of targets.fields) out.set(field.group, [...(out.get(field.group) ?? []), field]);
    return [...out.entries()];
  }, [targets]);

  const shownSources = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const fields = source?.fields ?? [];
    return needle ? fields.filter((f) => describeSourcePath(f.path).toLowerCase().includes(needle)) : fields;
  }, [source, filter]);

  const chosenField = target ? targets.fields.find((f) => sameTarget(f.target, target)) : undefined;
  const typedPath = typedField.trim() ? parseBodyPath(typedField) : null;
  const typedSourcePath = (() => {
    const text = typedSource.trim().replace(/^\./, "");
    if (!text) return null;
    const path = parsePath(`.${text}`);
    return path.length && ["status", "headers", "body"].includes(String(path[0])) ? path : null;
  })();

  const ready = Boolean(target && source && sourcePath?.length);
  const bare = target?.in === "body" ? (chosenField?.bare ?? targets.bareFor(target.path)) : false;

  const save = () => {
    if (!target || !source || !sourcePath?.length) return;
    const problem = onSave({ targetIndex, target, source: { step: source.key, path: sourcePath }, bare }, initial.editing);
    if (problem) setError(problem);
    else onClose();
  };

  const isEditing = Boolean(initial.editing);

  return (
    <div className="scrim top" onClick={onClose}>
      <div
        className="modal link-value-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="link-dialog-title"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="modal-head">
          <Link2 size={14} aria-hidden />
          <strong id="link-dialog-title">{isEditing ? "Change link" : "Pass a value between steps"}</strong>
          <span className="spacer" />
          <button type="button" className="icon-btn tight" aria-label="Close" onClick={onClose}>
            <X size={15} />
          </button>
        </div>

        <div className="link-columns">
          <section className="link-col" aria-labelledby="link-into">
            <h3 id="link-into">1. Fill this field</h3>
            <label className="link-select">
              <span className="field-meta">Step</span>
              <select ref={first} value={targetIndex} onChange={(event) => changeTargetStep(Number(event.target.value))}>
                {collection.steps.map((s, i) => (
                  <option key={s.key} value={i} disabled={i === 0 && initial.targetIndex !== 0}>
                    {i + 1}. {s.name || s.key}
                    {i === 0 ? " (runs first)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <div className="link-options" role="radiogroup" aria-label={`Fields of ${targetTitle}`}>
              {groups.map(([group, fields]) => (
                <div key={group} className="link-group">
                  <div className="link-group-label">{group}</div>
                  {fields.map((field) => {
                    const selected = Boolean(target && sameTarget(field.target, target));
                    const linked = field.current && /\{\{\s*steps\./.test(field.current);
                    return (
                      <button
                        key={targetId(field.target)}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        className="link-option"
                        onClick={() => setTarget(field.target)}
                      >
                        <span className="mono link-option-name">
                          {field.label}
                          {field.required && <span className="required">*</span>}
                        </span>
                        <span className="link-option-meta">
                          {linked ? "linked now" : field.current ? shorten(redact(field.current), 24) : (field.type ?? "")}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
              {targets.takesBody && targets.bodyProblem && (
                <p className="field-meta link-note">
                  {targets.bodyProblem} Body fields can be linked once the body in the step&apos;s Request tab is valid JSON.
                </p>
              )}
              <div className="link-group">
                <div className="link-group-label">Another field</div>
                <div className="link-typed">
                  <input
                    value={typedHeader}
                    placeholder="Header name"
                    aria-label="Another header"
                    onChange={(event) => setTypedHeader(event.target.value)}
                  />
                  <button
                    type="button"
                    className="btn"
                    disabled={!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(typedHeader.trim())}
                    onClick={() => setTarget({ in: "header", name: typedHeader.trim() })}
                  >
                    Use header
                  </button>
                </div>
                {targets.takesBody && !targets.bodyProblem && (
                  <div className="link-typed">
                    <input
                      value={typedField}
                      placeholder="Body field, e.g. items[0].sku"
                      aria-label="Another body field"
                      aria-invalid={Boolean(typedField.trim() && !typedPath)}
                      onChange={(event) => setTypedField(event.target.value)}
                    />
                    <button type="button" className="btn" disabled={!typedPath} onClick={() => typedPath && setTarget({ in: "body", path: typedPath })}>
                      Use field
                    </button>
                  </div>
                )}
              </div>
            </div>
          </section>

          <section className="link-col" aria-labelledby="link-from">
            <h3 id="link-from">2. With this value</h3>
            {!earlier.length ? (
              <p className="field-meta link-note">
                {targetTitle} runs first, so there's no earlier step to take a value from. Choose a later step on the left.
              </p>
            ) : (
              <>
                <label className="link-select">
                  <span className="field-meta">From the response of</span>
                  <select
                    value={source?.key ?? ""}
                    onChange={(event) => {
                      setSourceKey(event.target.value);
                      setSourcePath(undefined);
                      setFilter("");
                    }}
                  >
                    {!source && <option value="">Choose a step…</option>}
                    {earlier.map((s) => (
                      <option key={s.key} value={s.key}>
                        {s.index + 1}. {s.title}
                      </option>
                    ))}
                  </select>
                </label>
                {source && (
                  <>
                    <div className="field-meta link-note">
                      {source.from === "response"
                        ? "Fields and values from its last run."
                        : source.from === "schema"
                          ? "Fields from the response the spec declares. Run the collection to see real values."
                          : "It hasn't run and its spec declares no response body. Type the field below, or run the collection first."}
                    </div>
                    {source.fields.length > 8 && (
                      <input
                        className="link-filter"
                        value={filter}
                        placeholder="Filter fields…"
                        aria-label="Filter fields"
                        onChange={(event) => setFilter(event.target.value)}
                      />
                    )}
                    <div className="link-options" role="radiogroup" aria-label={`Response fields of ${source.title}`}>
                      {sourcePath && !source.fields.some((f) => describeSourcePath(f.path) === describeSourcePath(sourcePath)) && (
                        <button type="button" role="radio" aria-checked className="link-option">
                          <span className="mono link-option-name">{describeSourcePath(sourcePath)}</span>
                          <span className="link-option-meta danger-ink">not in {source.from === "response" ? "the last response" : "the spec"}</span>
                        </button>
                      )}
                      {shownSources.map((field) => {
                        const label = describeSourcePath(field.path);
                        const selected = Boolean(sourcePath && describeSourcePath(sourcePath) === label);
                        return (
                          <button
                            key={field.reference}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            className="link-option"
                            onClick={() => setSourcePath(field.path)}
                          >
                            <span className="mono link-option-name">{label}</span>
                            <span className="link-option-meta" title={redact(field.preview)}>
                              {shorten(redact(field.preview), 28)}
                            </span>
                          </button>
                        );
                      })}
                      {!shownSources.length && source.fields.length > 0 && <p className="field-meta link-note">No field matches.</p>}
                    </div>
                    <div className="link-typed">
                      <input
                        value={typedSource}
                        placeholder="Or type one, e.g. body.data[0].id"
                        aria-label="Response field"
                        aria-invalid={Boolean(typedSource.trim() && !typedSourcePath)}
                        onChange={(event) => setTypedSource(event.target.value)}
                      />
                      <button
                        type="button"
                        className="btn"
                        disabled={!typedSourcePath}
                        onClick={() => typedSourcePath && setSourcePath(typedSourcePath)}
                      >
                        Use
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
          </section>
        </div>

        <div className="modal-foot link-foot">
          <div className="link-summary" aria-live="polite">
            {target ? (
              <span>
                <strong>{targetTitle}</strong> <span className="mono">{describeLinkTarget(target)}</span>
              </span>
            ) : (
              <span className="field-meta">Choose a field</span>
            )}
            <ArrowLeft size={13} aria-label="takes its value from" />
            {source && sourcePath?.length ? (
              <span>
                <strong>{source.title}</strong> <span className="mono">{describeSourcePath(sourcePath)}</span>
              </span>
            ) : (
              <span className="field-meta">Choose a value</span>
            )}
          </div>
          {error && <div className="danger-ink field-meta">{error}</div>}
          <span className="spacer" style={{ flex: 1 }} />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={!ready} onClick={save}>
            {isEditing ? "Save link" : "Add link"}
          </button>
        </div>
      </div>
    </div>
  );
}
