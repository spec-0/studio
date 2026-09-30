import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { NamingState } from "../../hooks/useCollections";

/**
 * Naming a collection: when it's created (from the list or from "Add to
 * collection ▸ New collection…") and when it's renamed. The field starts with
 * a sensible name, selected, so typing replaces it and Enter keeps it.
 */
export function NameDialog({ state, onClose }: { state: NamingState; onClose: () => void }) {
  const [name, setName] = useState(state.initial);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const trimmed = name.trim();
  const submit = () => {
    if (!trimmed) return;
    onClose();
    state.apply(trimmed);
  };
  return (
    <div className="scrim top" onClick={onClose}>
      <form
        className="modal name-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="name-dialog-title"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="modal-head">
          <strong id="name-dialog-title">{state.title}</strong>
          <span className="spacer" />
          <button type="button" className="icon-btn tight" aria-label="Cancel" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
        <div className="modal-body">
          <label className="name-field">
            <span className="field-meta">Name</span>
            <input ref={input} value={name} onChange={(event) => setName(event.target.value)} aria-label="Collection name" />
          </label>
          {!state.collectionId && (
            <p className="field-meta" style={{ marginTop: 8 }}>
              A collection runs steps in order. You can rename it later from its header or the list.
            </p>
          )}
        </div>
        <div className="modal-foot">
          <span className="spacer" style={{ flex: 1 }} />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!trimmed}>
            {state.confirm}
          </button>
        </div>
      </form>
    </div>
  );
}
