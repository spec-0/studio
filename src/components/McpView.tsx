import { McpSettings } from "./settings/McpSettings";

/** The MCP tab. Its content is the same component as the MCP section in Settings. */
export function McpView({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <div className="page">
      <div className="page-inner">
        <div className="library-head">
          <div>
            <h1>MCP</h1>
            <p className="page-sub">
              Give your coding agent the same view of your APIs that you have in Studio.
            </p>
          </div>
          <span className="spacer" />
          <button className="btn" onClick={onOpenSettings}>
            MCP settings
          </button>
        </div>
        <McpSettings />
      </div>
    </div>
  );
}
