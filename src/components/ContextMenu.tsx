import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

export interface MenuItem {
  label: ReactNode;
  /** Plain text for screen readers and type-ahead when `label` isn't a string. */
  text?: string;
  onSelect?: () => void;
  submenu?: MenuItem[];
  disabled?: boolean;
  /** A line above this item. */
  separator?: boolean;
  hint?: string;
}

interface Props {
  /** Where to open, in window coordinates: the pointer, or under a button. */
  x: number;
  y: number;
  items: MenuItem[];
  label: string;
  onClose: () => void;
}

/**
 * A menu that opens where you right-click, or under the button that opened it.
 *
 * Follows the WAI-ARIA menu pattern: focus moves into the menu, arrow keys move
 * between items, Right opens a submenu and Left closes it, Enter or Space
 * chooses, Escape closes and returns focus to where it was.
 */
export function ContextMenu({ x, y, items, label, onClose }: Props) {
  const menu = useRef<HTMLDivElement>(null);
  const returnTo = useRef<Element | null>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    returnTo.current = document.activeElement;
    const rect = menu.current?.getBoundingClientRect();
    if (!rect) return;
    // Keep the whole menu on screen.
    setPosition({
      left: Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)),
    });
  }, [x, y]);

  useEffect(() => {
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
    const close = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) onClose();
    };
    const blur = () => onClose();
    window.addEventListener("mousedown", close, true);
    window.addEventListener("blur", blur);
    window.addEventListener("resize", blur);
    return () => {
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("blur", blur);
      window.removeEventListener("resize", blur);
      if (returnTo.current instanceof HTMLElement && document.body.contains(returnTo.current)) {
        returnTo.current.focus();
      }
    };
  }, [onClose]);

  return (
    <div
      ref={menu}
      className="context-menu"
      style={{ left: position.left, top: position.top }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <MenuList items={items} label={label} onClose={onClose} root />
    </div>
  );
}

function MenuList({
  items,
  label,
  onClose,
  root = false,
  onBack,
}: {
  items: MenuItem[];
  label: string;
  onClose: () => void;
  root?: boolean;
  onBack?: () => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<number | null>(null);

  const focusable = () =>
    [...(list.current?.querySelectorAll<HTMLElement>(':scope > .menu-slot > [role="menuitem"]') ?? [])].filter(
      (el) => el.getAttribute("aria-disabled") !== "true",
    );

  useEffect(() => {
    if (!root) focusable()[0]?.focus();
  }, [root]);

  const choose = (item: MenuItem, index: number) => {
    if (item.disabled) return;
    if (item.submenu) {
      setOpen(index);
      return;
    }
    onClose();
    item.onSelect?.();
  };

  return (
    <div
      ref={list}
      role="menu"
      aria-label={label}
      className="menu-list"
      onKeyDown={(event) => {
        const nodes = focusable();
        const at = nodes.indexOf(document.activeElement as HTMLElement);
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          event.stopPropagation();
          const step = event.key === "ArrowDown" ? 1 : -1;
          nodes[(at + step + nodes.length) % nodes.length]?.focus();
        } else if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          event.stopPropagation();
          nodes[event.key === "Home" ? 0 : nodes.length - 1]?.focus();
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (onBack) onBack();
          else onClose();
        } else if (event.key === "ArrowLeft" && onBack) {
          event.preventDefault();
          event.stopPropagation();
          onBack();
        } else if (event.key === "Tab") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      {items.map((item, index) => (
        <div className="menu-slot" key={index}>
          {item.separator && <div className="menu-sep" role="separator" />}
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            tabIndex={-1}
            aria-disabled={item.disabled || undefined}
            aria-haspopup={item.submenu ? "menu" : undefined}
            aria-expanded={item.submenu ? open === index : undefined}
            onMouseEnter={(event) => {
              if (item.submenu && !item.disabled) setOpen(index);
              else setOpen(null);
              (event.currentTarget as HTMLElement).focus();
            }}
            onClick={() => choose(item, index)}
            onKeyDown={(event) => {
              if ((event.key === "ArrowRight" || event.key === "Enter" || event.key === " ") && item.submenu) {
                event.preventDefault();
                event.stopPropagation();
                if (!item.disabled) setOpen(index);
              } else if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                event.stopPropagation();
                choose(item, index);
              }
            }}
          >
            <span className="menu-label">{item.label}</span>
            {item.hint && <span className="menu-hint">{item.hint}</span>}
            {item.submenu && <ChevronRight size={13} aria-hidden className="menu-chev" />}
          </button>
          {item.submenu && open === index && (
            <div className="context-menu submenu">
              <MenuList
                items={item.submenu}
                label={item.text ?? (typeof item.label === "string" ? item.label : label)}
                onClose={onClose}
                onBack={() => {
                  setOpen(null);
                  list.current
                    ?.querySelectorAll<HTMLElement>(':scope > .menu-slot > [role="menuitem"]')
                    [index]?.focus();
                }}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
