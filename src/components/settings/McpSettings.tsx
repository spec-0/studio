import { Bot } from "lucide-react";

/**
 * The MCP section: a local MCP server that lets a coding agent see the APIs
 * open in Studio.
 *
 * A placeholder for now. It's shown both as the MCP tab in the top bar and as
 * the MCP section in Settings, so filling in this one component fills in both.
 */
export function McpSettings() {
  return (
    <div className="placeholder-card">
      <Bot size={18} aria-hidden />
      <div>
        <p>
          Run a local MCP server so your coding agent can see the APIs in Studio.{" "}
          <span className="tag">coming soon</span>
        </p>
        <p className="field-meta">
          It will run on this machine only, and only when you turn it on.
        </p>
      </div>
    </div>
  );
}
