import { useCallback, useEffect, useRef } from "react";

interface Props {
  width: number;
  onChange: (width: number) => void;
  min?: number;
  max?: number;
  /** Which side of the handle the panel sits on. */
  side?: "right" | "left";
}

/**
 * Drag handle for a side panel.
 *
 * Listeners are attached to the window rather than the handle so a fast drag
 * doesn't lose the pointer, and `user-select` is suppressed for the duration —
 * without it a drag across the panel selects its text instead of resizing.
 */
export function Resizer({ width, onChange, min = 240, max = 720, side = "right" }: Props) {
  const dragging = useRef(false);
  const start = useRef({ x: 0, width: 0 });

  const onMove = useCallback(
    (event: MouseEvent) => {
      if (!dragging.current) return;
      const delta = event.clientX - start.current.x;
      const next = side === "right" ? start.current.width - delta : start.current.width + delta;
      onChange(Math.round(Math.min(max, Math.max(min, next))));
    },
    [onChange, min, max, side],
  );

  const onUp = useCallback(() => {
    dragging.current = false;
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  }, []);

  useEffect(() => {
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [onMove, onUp]);

  return (
    <div
      className="resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      tabIndex={0}
      onMouseDown={(event) => {
        dragging.current = true;
        start.current = { x: event.clientX, width };
        document.body.style.userSelect = "none";
        document.body.style.cursor = "col-resize";
      }}
      onKeyDown={(event) => {
        // Keyboard-resizable too — this app is otherwise fully navigable without a mouse.
        if (event.key === "ArrowLeft") onChange(Math.min(max, width + 24));
        if (event.key === "ArrowRight") onChange(Math.max(min, width - 24));
      }}
    />
  );
}
