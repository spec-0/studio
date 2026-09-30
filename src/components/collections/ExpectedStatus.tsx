import { useEffect, useId, useState } from "react";
import {
  DEFAULT_EXPECTED_STATUS,
  describeExpected,
  expectedStatusOf,
  normaliseExpectedStatus,
  type CollectionStep,
} from "../../lib/collection";

interface Props {
  step: CollectionStep;
  /** The statuses the step's operation declares, offered first. */
  declared: readonly string[];
  onChange: (change: (step: CollectionStep) => CollectionStep) => void;
}

/**
 * The status a step expects, in the step's header: empty for any 2xx, a code,
 * or a class like 4XX. The spec's own statuses are suggested.
 */
export function ExpectedStatusField({ step, declared, onChange }: Props) {
  const current = expectedStatusOf(step) ?? "";
  const [draft, setDraft] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const listId = useId();
  useEffect(() => {
    setDraft(current);
    setError(null);
  }, [step.key, current]);

  const suggestions = [
    ...new Set([
      DEFAULT_EXPECTED_STATUS,
      ...declared.map((s) => s.toUpperCase()).filter((s) => normaliseExpectedStatus(s)),
      "4XX",
      "5XX",
    ]),
  ];

  const commit = (value: string) => {
    const text = value.trim();
    const status = text ? normaliseExpectedStatus(text) : DEFAULT_EXPECTED_STATUS;
    if (!status) {
      setError("Use a status like 404, or a range like 4XX.");
      return;
    }
    setError(null);
    setDraft(status === DEFAULT_EXPECTED_STATUS ? "" : status);
    if (status === (current || DEFAULT_EXPECTED_STATUS)) return;
    onChange(({ expect: _old, ...rest }) => (status === DEFAULT_EXPECTED_STATUS ? rest : { ...rest, expect: { status } }));
  };

  return (
    <label className="step-field step-expect-field">
      <span className="field-meta">Expects</span>
      <input
        className="mono"
        value={draft}
        placeholder="any 2xx"
        list={listId}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${listId}-error` : undefined}
        title={`The step passes when the server answers ${describeExpected(current || undefined)} and the response matches the spec for that status.`}
        data-no-insert
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => commit(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") (event.target as HTMLInputElement).blur();
        }}
      />
      <datalist id={listId}>
        {suggestions.map((s) => (
          <option key={s} value={s}>
            {describeExpected(s)}
          </option>
        ))}
      </datalist>
      {error && (
        <span id={`${listId}-error`} className="field-meta danger-ink">
          {error}
        </span>
      )}
    </label>
  );
}
