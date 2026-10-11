import type { KeyPress } from "./shortcuts";

/**
 * Whether the chat panel is open. Kept outside React, like the console's, so
 * the status bar button and the shortcut can toggle it from anywhere.
 */

let open = false;
const listeners = new Set<() => void>();

export function subscribeAgentChatPanel(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function agentChatPanelOpen(): boolean {
  return open;
}

export function setAgentChatPanelOpen(next: boolean): void {
  if (next === open) return;
  open = next;
  for (const listener of listeners) listener();
}

export function toggleAgentChatPanel(): void {
  setAgentChatPanelOpen(!open);
}

/**
 * ⌘⇧J on macOS, Ctrl+Shift+J elsewhere, opens and closes the chat panel.
 * Matched on the physical key, like the console's shortcut.
 */
export function isAgentChatShortcut(press: KeyPress, { mac }: { mac: boolean }): boolean {
  const command = mac ? press.metaKey && !press.ctrlKey : press.ctrlKey && !press.metaKey;
  return command && press.shiftKey && !press.altKey && press.code === "KeyJ";
}

export function agentChatShortcutLabel(mac: boolean): string {
  return mac ? "⇧⌘J" : "Ctrl+Shift+J";
}
