import { useEffect, useRef } from "react";
import { menuClosesTabs, onCloseTabRequested } from "../lib/appMenu";
import { sectionForKey, type ApiSection } from "../lib/navigation";
import { isMac } from "../lib/platform";
import { isConsoleShortcut, tabShortcutFor, type TabShortcut } from "../lib/shortcuts";

export interface ShortcutActions {
  /** ⌘/Ctrl+Enter sends the request on screen; see `sendTargetFor`. */
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
  /** ⌘/Ctrl+1–4: Operations, Schemas, Graph, Document */
  showSection: (section: ApiSection) => void;
  /** ⌘/Ctrl+, */
  openSettings: () => void;
  /** ⌘/Ctrl+D */
  toggleTheme: () => void;
  /** Escape */
  closeDialogs: () => void;
  /**
   * Ctrl+Tab / Ctrl+Shift+Tab (and ⌘⇧] / ⌘⇧[ on macOS) move between request
   * tabs; ⌘/Ctrl+W closes the current one. See `tabShortcutFor`.
   */
  requestTab: (action: TabShortcut) => void;
  /** ⌘⇧Y / Ctrl+Shift+Y opens the app console; see `isConsoleShortcut`. */
  toggleConsole: () => void;
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
      const tabAction = tabShortcutFor(event, { mac: isMac, menuClosesTabs });
      if (tabAction) {
        event.preventDefault();
        act.requestTab(tabAction);
      } else if (isConsoleShortcut(event, { mac: isMac })) {
        event.preventDefault();
        act.toggleConsole();
      } else if (meta && event.key === "Enter") {
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
      } else if (meta && sectionForKey(event.key)) {
        event.preventDefault();
        act.showSection(sectionForKey(event.key)!);
      } else if (meta && event.key === ",") {
        event.preventDefault();
        act.openSettings();
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
    // ⌘W in the macOS app arrives from the menu instead.
    let stopped = false;
    let stopMenu: (() => void) | null = null;
    void onCloseTabRequested(() => latest.current.requestTab("close")).then((unlisten) => {
      if (stopped) unlisten();
      else stopMenu = unlisten;
    });
    return () => {
      window.removeEventListener("keydown", onKey);
      stopped = true;
      stopMenu?.();
    };
  }, []);
}
