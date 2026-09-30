import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { PickableField } from "../../lib/chain";

export interface EarlierStep {
  key: string;
  title: string;
  fields: PickableField[];
  /** Where the fields came from: the last run's response, or the declared schema. */
  from: "response" | "schema" | "none";
}

interface Props {
  steps: EarlierStep[];
  onPick: (reference: string) => void;
}

/**
 * "Use a value from an earlier step": the fields of each earlier step's last
 * response (or, before it has run, of its declared response), each one a
 * button that puts its reference into the field you were last in.
 */
export function ValuePicker({ steps, onPick }: Props) {
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState(steps[steps.length - 1]?.key ?? "");
  const [filter, setFilter] = useState("");
  const step = steps.find((s) => s.key === chosen) ?? steps[steps.length - 1];
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const fields = step?.fields ?? [];
    return needle ? fields.filter((f) => f.reference.toLowerCase().includes(needle)) : fields;
  }, [step, filter]);

  if (!steps.length) return null;
  return (
    <div className="value-picker">
      <button
        type="button"
        className="value-picker-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        // Keep the field you were in as the one a value goes into.
        onMouseDown={(event) => event.preventDefault()}
      >
        {open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
        Use a value from an earlier step
      </button>
      {open && step && (
        <div className="value-picker-body">
          <div className="value-picker-bar">
            <select
              aria-label="Earlier step"
              value={step.key}
              data-no-insert
              onChange={(event) => setChosen(event.target.value)}
            >
              {steps.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.title}
                </option>
              ))}
            </select>
            <input
              aria-label="Filter fields"
              placeholder="Filter fields…"
              value={filter}
              data-no-insert
              onChange={(event) => setFilter(event.target.value)}
            />
          </div>
          <div className="field-meta">
            {step.from === "response"
              ? "From the last run. Click a field in this step first, then a value."
              : step.from === "schema"
                ? "From the response the spec declares; run the collection to see real values. Click a field in this step first, then a value."
                : "Nothing to pick yet: this step has no run and no declared response."}
          </div>
          <div className="value-picker-list" role="list">
            {shown.map((field) => (
              <button
                key={field.reference}
                type="button"
                role="listitem"
                className="value-pick"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onPick(field.reference)}
                title={`Insert ${field.reference}`}
              >
                <span className="mono">{field.reference.slice(`{{steps.${step.key}.`.length, -2)}</span>
                <span className="meta">{field.preview}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
