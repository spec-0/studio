import { McpPanel } from "./mcp/McpPanel";

/** The MCP tab: the one place the local MCP server is set up and watched. */
export function McpView({ signedIn }: { signedIn: boolean }) {
  return (
    <div className="page">
      <McpPanel signedIn={signedIn} />
    </div>
  );
}
