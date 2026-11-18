import { McpSettings } from "./settings/McpSettings";

/** The MCP tab: the one place the local MCP server is set up and watched. */
export function McpView({ signedIn }: { signedIn: boolean }) {
  return (
    <div className="page">
      <div className="page-inner">
        <div className="library-head">
          <div>
            <h1>MCP server</h1>
            <p className="page-sub">
              Give your coding agent the same view of your APIs that you have in Studio.
            </p>
          </div>
        </div>
        <McpSettings signedIn={signedIn} />
      </div>
    </div>
  );
}
