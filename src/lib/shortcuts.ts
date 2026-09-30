import type { Route } from "./navigation";

/** The screens the send shortcut can be pressed on. */
export type SendScreen = Route;

/**
 * Which request ⌘/Ctrl+Enter sends: the one on screen. The scratch pad sends its
 * own request, an open API sends the selected operation, and every other screen
 * (the library, history, mocks, MCP, settings) has nothing to send.
 */
export function sendTargetFor(screen: SendScreen): "scratch" | "operation" | null {
  if (screen === "scratch") return "scratch";
  if (screen === "api") return "operation";
  return null;
}

/** What a key press asks of the request tabs. */
export type TabShortcut = "next" | "previous" | "close";

/** The parts of a keyboard event the tab shortcuts look at. */
export interface KeyPress {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * The request-tab shortcuts, which don't clash with ⌘/Ctrl+1–4 (the API views):
 *
 * - Ctrl+Tab and Ctrl+Shift+Tab move to the next and previous tab, on every
 *   platform (⌘Tab belongs to macOS).
 * - ⌘⇧] and ⌘⇧[ do the same on macOS, as in Safari and Xcode. Matched on the
 *   physical key, because Shift turns `]` into `}` on many layouts.
 * - ⌘W / Ctrl+W closes the current tab. In the macOS app the menu owns ⌘W (so it
 *   can say "Close Tab" or "Close Window"), and `menuClosesTabs` keeps the key
 *   from being handled twice.
 */
export function tabShortcutFor(
  press: KeyPress,
  { mac, menuClosesTabs }: { mac: boolean; menuClosesTabs: boolean },
): TabShortcut | null {
  if (press.altKey) return null;
  if (press.key === "Tab" && press.ctrlKey && !press.metaKey) return press.shiftKey ? "previous" : "next";
  const command = mac ? press.metaKey && !press.ctrlKey : press.ctrlKey && !press.metaKey;
  if (mac && command && press.shiftKey) {
    if (press.code === "BracketRight") return "next";
    if (press.code === "BracketLeft") return "previous";
  }
  if (command && !press.shiftKey && press.key.toLowerCase() === "w" && !menuClosesTabs) return "close";
  return null;
}
