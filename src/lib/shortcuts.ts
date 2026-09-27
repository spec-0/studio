/** The screens the send shortcut can be pressed on. */
export type SendScreen = "library" | "api" | "scratch" | "history";

/**
 * Which request ⌘/Ctrl+Enter sends: the one on screen. The scratch pad sends its
 * own request, an open API sends the selected operation, and the library and
 * the history list have nothing to send.
 */
export function sendTargetFor(screen: SendScreen): "scratch" | "operation" | null {
  if (screen === "scratch") return "scratch";
  if (screen === "api") return "operation";
  return null;
}
