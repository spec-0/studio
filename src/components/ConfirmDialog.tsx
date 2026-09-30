import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

interface Props {
  title: string;
  children: ReactNode;
  /** The button that goes ahead, e.g. "Remove step". */
  confirm: string;
  /** Going ahead loses something: the button says so in red. */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * "Are you sure?", for the few actions that lose work or break something.
 *
 * Cancel has focus, so a reflexive Enter changes nothing. Escape and clicking
 * outside cancel too.
 */
export function ConfirmDialog({ title, children, confirm, danger, onConfirm, onCancel }: Props) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  return (
    <div className="scrim" onClick={onCancel}>
      <div
        className="modal confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-body"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onCancel();
          }
        }}
      >
        <div className="modal-head">
          <strong id="confirm-title">{title}</strong>
          <span className="spacer" />
          <button type="button" className="icon-btn tight" aria-label="Cancel" onClick={onCancel}>
            <X size={15} />
          </button>
        </div>
        <div className="modal-body" id="confirm-body">
          {children}
        </div>
        <div className="modal-foot">
          <span className="spacer" style={{ flex: 1 }} />
          <button type="button" className="btn" ref={cancel} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className={`btn ${danger ? "danger-outline" : "primary"}`} onClick={onConfirm}>
            {confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
