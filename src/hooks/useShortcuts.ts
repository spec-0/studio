import { useEffect, useRef } from "react";
import type { SidebarTab } from "../components/Sidebar";

export interface ShortcutActions {
  /** ⌘/Ctrl+Enter — sends the request on screen; see `sendTargetFor`. */
  send: () => void;
  /** ⌘/Ctrl+O */
  openAdd: () => void;
  /** ⌘/Ctrl+P */
  openSwitcher: () => void;
  /** ⌘/Ctrl+E */
  openEnvironments: () => void;
  /** ⌘/Ctrl+L */
  goLibrary: () => void;
  /** ⌘/Ctrl+\ */
  toggleInspector: () => void;
  /** ⌘/Ctrl+1, 2, 3 */
  showTab: (tab: SidebarTab) => void;
  /** ⌘/Ctrl+D */
  toggleTheme: () => void;
  /** Escape */
  closeDialogs: () => void;
}

/**
 * The app's keyboard shortcuts, on one window listener.
 *
 * The actions are read through a ref, so the listener is added once and always
 * calls the latest version of each action.
 */
export function useShortcuts(actions: ShortcutActions) {
  const latest = useRef(actions);
  latest.current = actions;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const act = latest.current;
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key === "Enter") {
        event.preventDefault();
        act.send();
      } else if (meta && event.key === "o") {
        event.preventDefault();
        act.openAdd();
      } else if (meta && event.key === "p") {
        event.preventDefault();
        act.openSwitcher();
      } else if (meta && event.key === "e") {
        event.preventDefault();
        act.openEnvironments();
      } else if (meta && event.key === "l") {
        event.preventDefault();
        act.goLibrary();
      } else if (meta && event.key === "\\") {
        event.preventDefault();
        act.toggleInspector();
      } else if (meta && ["1", "2", "3"].includes(event.key)) {
        event.preventDefault();
        act.showTab(event.key === "1" ? "operations" : event.key === "2" ? "schemas" : "history");
      } else if (meta && event.key === "d") {
        event.preventDefault();
        act.toggleTheme();
      } else if (event.key === "/" && document.activeElement?.tagName !== "INPUT") {
        event.preventDefault();
        document.getElementById("sidebar-search")?.focus();
      } else if (event.key === "Escape") {
        act.closeDialogs();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
