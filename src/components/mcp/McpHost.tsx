import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { ensureBridge, loadMcpPrefs, onOpenRequested, startMcp } from "../../lib/mcpServer";
import { inTauri } from "../../lib/request";
import { McpPanel } from "./McpPanel";

/**
 * The always-mounted part of the local MCP server.
 *
 * Answers tool calls (the bridge), starts the server at launch only if the user
 * turned that on, and, for now, opens {@link McpPanel} in a dialog from the
 * "Local MCP Server…" menu item. Renders nothing until that item is picked.
 */
export function McpHost({ signedIn }: { signedIn: boolean }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!inTauri) return;
    let stopped = false;
    let unlisten: (() => void) | null = null;
    void ensureBridge();
    void onOpenRequested(() => setOpen(true)).then((stop) => (stopped ? stop() : (unlisten = stop)));
    void loadMcpPrefs().then((prefs) => {
      // Off unless the user asked for it. A failure here stays quiet; the panel
      // shows the state when it's opened.
      if (!stopped && prefs.startOnLaunch) void startMcp(prefs).catch(() => undefined);
    });
    return () => {
      stopped = true;
      unlisten?.();
    };
  }, []);

  if (!open) return null;
  return (
    <div className="scrim" onClick={() => setOpen(false)}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <strong>Local MCP server</strong>
          <span className="spacer" />
          <button className="icon-btn tight" onClick={() => setOpen(false)} aria-label="Close">
            <X size={15} />
          </button>
        </div>
        <div className="modal-body">
          <McpPanel signedIn={signedIn} />
        </div>
        <div className="modal-foot">
          <span className="spacer" style={{ flex: 1 }} />
          <button className="btn primary" onClick={() => setOpen(false)}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
