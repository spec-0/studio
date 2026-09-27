import { useEffect, useMemo, useState } from "react";
import { Copy, Eye, EyeOff, RefreshCw } from "lucide-react";
import { useMcpServer } from "../../hooks/useMcpServer";
import { MCP_TOOLS } from "../../lib/mcp";
import { endpoint, maskToken, setupSnippets } from "../../lib/mcpServer";
import { inTauri } from "../../lib/request";

interface Props {
  /** Signed in to Spec0: the mock server tools work. */
  signedIn: boolean;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <button
      className="btn"
      onClick={() => void navigator.clipboard.writeText(value).then(() => setCopied(true))}
      aria-label={label}
      title={label}
    >
      <Copy size={12} /> {copied ? "Copied" : "Copy"}
    </button>
  );
}

/**
 * Settings and status for Studio's local MCP server. Self-contained: it holds
 * its own state through `useMcpServer`, so it can sit in a dialog, a settings
 * page or a tab without anything else changing.
 */
export function McpPanel({ signedIn }: Props) {
  const mcp = useMcpServer();
  const { prefs, status } = mcp;
  const [showToken, setShowToken] = useState(false);
  const [client, setClient] = useState("claude-code");
  const [portDraft, setPortDraft] = useState(String(prefs.port));

  useEffect(() => setPortDraft(String(prefs.port)), [prefs.port]);

  const port = status.running && status.port ? status.port : prefs.port;
  const url = endpoint(port);
  const snippets = useMemo(() => setupSnippets(port, prefs.token), [port, prefs.token]);
  const snippet = snippets.find((row) => row.id === client) ?? snippets[0];

  const applyPort = () => {
    const next = Number(portDraft);
    if (next !== prefs.port) mcp.setPort(next);
  };

  return (
    <div className="mcp-panel">
      <p className="mcp-lede">
        An MCP server lets AI coding agents on this computer, such as Claude Code or Cursor, ask Studio
        about your APIs.
      </p>

      <div className="mcp-row">
        <span className={`mcp-dot${status.running ? " on" : mcp.error ? " bad" : ""}`} aria-hidden />
        <span className="mcp-status" role="status">
          {status.running ? (
            <>
              Running on <code>127.0.0.1:{status.port}</code>
            </>
          ) : mcp.error ? (
            "Not running"
          ) : (
            "Stopped"
          )}
        </span>
        <span className="spacer" />
        {status.running ? (
          <button className="btn" onClick={() => void mcp.stop()} disabled={mcp.busy}>
            Stop
          </button>
        ) : (
          <button
            className="btn primary"
            onClick={() => void mcp.start()}
            disabled={mcp.busy || !mcp.loaded || !inTauri}
            title={inTauri ? undefined : "Needs the desktop app"}
          >
            {mcp.busy ? "Starting…" : "Start"}
          </button>
        )}
      </div>

      {mcp.error && <div className="error-box">{mcp.error}</div>}
      {mcp.movedPort && (
        <p className="mcp-warn">
          Port {prefs.port} was in use, so the server is on {status.port}. Update your agent&apos;s
          settings with the address below, or choose another port.
        </p>
      )}

      <div className="mcp-grid">
        <span className="mcp-label">Address</span>
        <div className="mcp-value">
          <code className="mcp-mono">{url}</code>
          <CopyButton value={url} label="Copy address" />
        </div>

        <span className="mcp-label">Token</span>
        <div className="mcp-value">
          <code className="mcp-mono">{showToken ? prefs.token : maskToken(prefs.token, prefs.token)}</code>
          <button
            className="icon-btn tight"
            onClick={() => setShowToken((shown) => !shown)}
            aria-label={showToken ? "Hide token" : "Show token"}
            title={showToken ? "Hide token" : "Show token"}
          >
            {showToken ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
          <CopyButton value={prefs.token} label="Copy token" />
          <button
            className="btn"
            onClick={() => void mcp.regenerateToken()}
            disabled={mcp.busy || !mcp.loaded}
            title="Make a new token. Agents using the old one stop working."
          >
            <RefreshCw size={12} /> Regenerate
          </button>
        </div>

        <span className="mcp-label">Port</span>
        <div className="mcp-value">
          <input
            className="mcp-port"
            inputMode="numeric"
            value={portDraft}
            onChange={(event) => setPortDraft(event.target.value.replace(/[^0-9]/g, ""))}
            onBlur={applyPort}
            onKeyDown={(event) => {
              if (event.key === "Enter") applyPort();
            }}
            aria-label="Port"
          />
          <span className="field-meta">If it&apos;s taken, the next free port is used.</span>
        </div>
      </div>

      <label className="check">
        <input
          type="checkbox"
          checked={prefs.startOnLaunch}
          onChange={(event) => void mcp.setStartOnLaunch(event.target.checked)}
        />
        Start the server when Studio opens (off by default)
      </label>

      <h4 className="mcp-heading">Connect an agent</h4>
      <div className="mcp-tabs" role="tablist">
        {snippets.map((row) => (
          <button
            key={row.id}
            role="tab"
            aria-selected={row.id === snippet.id}
            className={`mcp-tab${row.id === snippet.id ? " on" : ""}`}
            onClick={() => setClient(row.id)}
          >
            {row.label}
          </button>
        ))}
      </div>
      <pre className="code mcp-snippet">{showToken ? snippet.text : maskToken(snippet.text, prefs.token)}</pre>
      <div className="mcp-row">
        <span className="field-meta">The copied text includes the token.</span>
        <span className="spacer" />
        <CopyButton value={snippet.text} label="Copy setup" />
      </div>

      <h4 className="mcp-heading">What agents can ask for</h4>
      <ul className="mcp-tools">
        {MCP_TOOLS.map((tool) => {
          const unavailable = tool.requiresSignIn && !signedIn;
          return (
            <li key={tool.name} className={unavailable ? "off" : undefined} title={tool.description}>
              <code>{tool.name}</code>
              <span className="mcp-tool-title">{tool.title}</span>
              {tool.requiresSignIn && (
                <span className="tag" title={unavailable ? "Sign in to Spec0 to use this" : "Uses your Spec0 sign-in"}>
                  sign-in
                </span>
              )}
            </li>
          );
        })}
      </ul>

      <p className="field-meta mcp-privacy">
        Only programs on this computer can connect, and only with the token. Secret variable values
        are never shared. Studio doesn&apos;t send requests for agents: they get URLs and call them
        themselves. The server stops when Studio quits.
      </p>
    </div>
  );
}
