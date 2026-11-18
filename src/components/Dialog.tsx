import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { X } from "lucide-react";

interface Props {
  title: ReactNode;
  /** One line under the title. */
  subtitle?: ReactNode;
  children: ReactNode;
  /** The footer's buttons, Cancel then the primary, on the right. */
  footer?: ReactNode;
  /** Context for the footer's left side, e.g. "Results go to History as one run". */
  footerContext?: ReactNode;
  onClose: () => void;
  /** ⌘↵ / Ctrl+↵ does this, where a dialog has one obvious action. */
  onConfirm?: () => void;
  /** 600px, or 820px for a dialog with two panes. */
  wide?: boolean;
  /** The body has no padding of its own, for two panes or a full-width list. */
  flush?: boolean;
  /** `alertdialog` for a confirmation. */
  role?: "dialog" | "alertdialog";
  className?: string;
  /** Element ids, for a title or body that a caller labels by. */
  labelId?: string;
  describedBy?: string;
  /** Clicking outside closes too (on by default). */
  closeOnScrim?: boolean;
  /** Don't move focus into the dialog when it opens; the caller focuses something. */
  keepFocus?: boolean;
  /** The frame is a form, so Enter in a field submits it (a `type="submit"` button). */
  onSubmit?: () => void;
  /** Anchored near the top, so the buttons don't move under the pointer as content changes. */
  top?: boolean;
  /** Something is under way that closing would abandon: ×, Escape and the scrim do nothing. */
  busy?: boolean;
  /** The frame element, for a dialog that manages its own focus. */
  frameRef?: RefObject<HTMLDivElement | null>;
  /** Underline tabs between the header and the body. */
  tabs?: ReactNode;
  /** An approval is answered, not dismissed: no ×, and Escape and the scrim are left to the caller. */
  closable?: boolean;
}

/**
 * The one dialog frame: a title, an optional subtitle and an × in the header;
 * the body; a footer with context on the left and Cancel then the primary on
 * the right. Escape closes, and ⌘↵ confirms where there's an obvious action.
 */
export function Dialog({
  title,
  subtitle,
  children,
  footer,
  footerContext,
  onClose,
  onConfirm,
  wide,
  flush,
  role = "dialog",
  className,
  labelId = "dialog-title",
  describedBy,
  closeOnScrim = true,
  keepFocus,
  onSubmit,
  top,
  busy,
  closable = true,
  tabs,
  frameRef,
}: Props) {
  const close = () => {
    if (!busy && closable) onClose();
  };
  const own = useRef<HTMLDivElement>(null);
  const frame = frameRef ?? own;
  const Frame = onSubmit ? "form" : "div";
  useEffect(() => {
    if (keepFocus) return;
    // Focus the frame itself, so Escape works at once without stealing a field.
    if (!frame.current?.contains(document.activeElement)) frame.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className={`scrim${top ? " top" : ""}`} onClick={closeOnScrim ? close : undefined}>
      <Frame
        ref={frame as never}
        tabIndex={-1}
        className={`modal dialog${wide ? " wide" : ""}${className ? ` ${className}` : ""}`}
        role={role}
        aria-modal="true"
        aria-labelledby={labelId}
        aria-describedby={describedBy}
        onClick={(event) => event.stopPropagation()}
        onSubmit={
          onSubmit
            ? (event) => {
                event.preventDefault();
                onSubmit();
              }
            : undefined
        }
        onKeyDown={(event) => {
          if (event.key === "Escape" && closable) {
            event.stopPropagation();
            close();
          } else if (onConfirm && event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            event.stopPropagation();
            onConfirm();
          }
        }}
      >
        <div className="modal-head dialog-head">
          <div className="l">
            <div className="title" id={labelId}>
              {title}
            </div>
            {subtitle && <span className="meta">{subtitle}</span>}
          </div>
          {closable && (
            <button type="button" className="icon-btn" aria-label="Close" title="Close (Esc)" disabled={busy} onClick={close}>
              <X size={15} />
            </button>
          )}
        </div>
        {tabs}
        <div className={`modal-body dialog-body${flush ? " flush" : ""}`}>{children}</div>
        {(footer || footerContext) && (
          <div className="modal-foot dialog-foot">
            <span className="ctx meta">{footerContext}</span>
            {footer}
          </div>
        )}
      </Frame>
    </div>
  );
}
