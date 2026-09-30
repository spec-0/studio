import { useEffect } from "react";
import { X } from "lucide-react";
import type { Collection } from "../../lib/collection";
import { ContextMenu, type MenuItem } from "../ContextMenu";

export interface AddMenuState {
  x: number;
  y: number;
  /** What's being added, for the menu's label. */
  what: string;
  onAdd: (collectionId: string | null) => void;
}

export interface AddedNote {
  text: string;
  collectionId: string;
}

/** "Add to collection ▸ <names> / New collection…" */
export function addToCollectionItems(collections: readonly Collection[], onAdd: (id: string | null) => void): MenuItem[] {
  return [
    {
      label: "Add to collection",
      text: "Add to collection",
      submenu: [
        ...collections.map((collection) => ({
          label: collection.name,
          hint: `${collection.steps.length} step${collection.steps.length === 1 ? "" : "s"}`,
          onSelect: () => onAdd(collection.id),
        })),
        { label: "New collection…", separator: collections.length > 0, onSelect: () => onAdd(null) },
      ],
    },
  ];
}

/** The menu, wherever it was opened: an operation in the sidebar, or a recorded request. */
export function AddToCollectionMenu({
  state,
  collections,
  onClose,
}: {
  state: AddMenuState | null;
  collections: readonly Collection[];
  onClose: () => void;
}) {
  if (!state) return null;
  return (
    <ContextMenu
      x={state.x}
      y={state.y}
      label={`Actions for ${state.what}`}
      items={addToCollectionItems(collections, state.onAdd)}
      onClose={onClose}
    />
  );
}

/** "Added getOrder to Checkout", with a way to go there. Goes away by itself. */
export function AddedToast({
  note,
  onOpen,
  onDismiss,
}: {
  note: AddedNote | null;
  onOpen: (collectionId: string) => void;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (!note) return;
    const timer = window.setTimeout(onDismiss, 5000);
    return () => window.clearTimeout(timer);
  }, [note, onDismiss]);
  if (!note) return null;
  return (
    <div className="toast" role="status">
      <span>{note.text}</span>
      <button type="button" className="btn" onClick={() => onOpen(note.collectionId)}>
        Open
      </button>
      <button type="button" className="icon-btn tight" aria-label="Dismiss" onClick={onDismiss}>
        <X size={13} />
      </button>
    </div>
  );
}
