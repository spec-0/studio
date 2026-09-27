/**
 * The few things that differ between macOS, Windows and Linux in the webview.
 *
 * Shortcuts already accept either ⌘ or Ctrl (see the key handler in App), so
 * this only decides what the labels say and how the titlebar is laid out.
 */

function detectMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const hint = navigator.platform || navigator.userAgent || "";
  return /Mac|iPhone|iPad/i.test(hint);
}

export const isMac = detectMac();

/**
 * The label for a shortcut: `⌘P` on macOS, `Ctrl+P` elsewhere.
 * `mac` is a parameter so tests can check both without faking a platform.
 */
export function shortcut(key: string, mac: boolean = isMac): string {
  return mac ? `⌘${key}` : `Ctrl+${key}`;
}

/**
 * The last part of a file path, for either separator. Windows paths use `\`,
 * and splitting only on `/` would show the whole path as the name.
 */
export function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
