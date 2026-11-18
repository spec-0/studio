import { useEffect, useRef, type ReactNode } from "react";
import { Dialog } from "./Dialog";

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
    <Dialog
      title={title}
      role="alertdialog"
      className="confirm-dialog"
      labelId="confirm-title"
      describedBy="confirm-body"
      keepFocus
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn" ref={cancel} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className={`btn ${danger ? "danger-outline" : "primary"}`} onClick={onConfirm}>
            {confirm}
          </button>
        </>
      }
    >
      <div id="confirm-body">{children}</div>
    </Dialog>
  );
}
