import { AlertTriangle, CircleHelp, Link2, X } from "lucide-react";
import { describeSourcePath, type LinkView } from "../../lib/chainLinks";
import type { Collection } from "../../lib/collection";
import { redact } from "../../lib/redact";

/** A value as a link shows it: secrets redacted, cut short, the whole of it on hover. */
export function shownValue(value: string | undefined, max = 32): { short: string; full: string } | null {
  if (value === undefined) return null;
  const full = redact(value);
  return { short: full.length > max ? `${full.slice(0, max - 1)}…` : full, full };
}

/** "Create order → body.id", naming the source step by its position and name. */
export function SourceLabel({ collection, view }: { collection: Collection; view: LinkView }) {
  const step = collection.steps[view.sourceIndex];
  return (
    <span className="link-source">
      {step ? (
        <>
          <span className="link-step-no">{view.sourceIndex + 1}</span>
          <span className="link-step-name">{step.name || step.key}</span>
        </>
      ) : (
        <span className="link-step-name">{view.source.step}</span>
      )}
      <span className="link-arrow" aria-hidden>
        →
      </span>
      <span className="mono">{describeSourcePath(view.source.path)}</span>
    </span>
  );
}

interface Props {
  collection: Collection;
  view: LinkView;
  onEdit: () => void;
  onRemove: () => void;
  /** The fix for a broken link, when there's a one-click one. */
  fix?: { label: string; run: () => void } | null;
  /** Inside other text rather than the whole field: smaller, and says "uses". */
  inline?: boolean;
}

/**
 * A field filled from an earlier step, shown as what it is ("from Create order
 * → body.id") rather than as `{{steps.createOrder.body.id}}`. After a run it
 * shows the value that was passed; a link that can't work says why.
 */
export function LinkChip({ collection, view, onEdit, onRemove, fix, inline }: Props) {
  const check = view.check;
  // A broken link passes nothing now, whatever it passed on an earlier run.
  const value = check.state === "broken" ? null : shownValue(view.value);
  const broken = check.state === "broken";
  const unchecked = check.state === "unchecked";
  const reason = check.state === "ok" ? undefined : check.reason;
  return (
    <div className={`link-chip-wrap${inline ? " inline" : ""}`}>
      <div className={`link-chip${broken ? " broken" : ""}`} title={reason}>
        {broken ? <AlertTriangle size={12} aria-hidden className="link-chip-icon" /> : <Link2 size={12} aria-hidden className="link-chip-icon" />}
        <span className="link-chip-text">
          <span className="link-chip-from">{inline ? "uses" : "from"}</span>
          <SourceLabel collection={collection} view={view} />
        </span>
        {unchecked && (
          <span className="link-chip-unchecked" aria-label={`Not checked yet: ${reason}`}>
            <CircleHelp size={12} aria-hidden />
          </span>
        )}
        {value && (
          <span className="link-chip-value mono" title={`Passed on the last run: ${value.full}`}>
            {value.short}
          </span>
        )}
        <span className="spacer" />
        <button type="button" className="btn ghost link-chip-btn" onClick={onEdit}>
          Change
        </button>
        <button type="button" className="icon-btn tight" aria-label="Remove link" title="Remove link" onClick={onRemove}>
          <X size={13} />
        </button>
      </div>
      {broken && (
        <div className="link-chip-problem" role="note">
          <span>{reason}</span>
          {fix && (
            <button type="button" className="btn" onClick={fix.run}>
              {fix.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
