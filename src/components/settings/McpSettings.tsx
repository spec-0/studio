import { McpPanel } from "../mcp/McpPanel";

/**
 * The MCP section: a local MCP server that lets a coding agent see the APIs
 * open in Studio. Shown both as the MCP tab and as the MCP section in Settings.
 */
export function McpSettings({ signedIn }: { signedIn: boolean }) {
  return <McpPanel signedIn={signedIn} />;
}
