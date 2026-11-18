import { useEffect, useRef, useState } from "react";
import type { NamingState } from "../../hooks/useCollections";
import { Dialog } from "../Dialog";

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
    <Dialog
      title={state.title}
      className="name-dialog"
      labelId="name-dialog-title"
      top
      keepFocus
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!trimmed}>
            {state.confirm}
          </button>
        </>
      }
    >
      <label className="name-field">
        <span className="label">Name</span>
        <input ref={input} className="input" value={name} onChange={(event) => setName(event.target.value)} aria-label="Collection name" />
      </label>
      {!state.collectionId && (
        <p className="meta" style={{ marginTop: 8 }}>
          A collection runs steps in order. You can rename it later from its header or the list.
        </p>
      )}
    </Dialog>
  );
}
