import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Copy, Eye, EyeOff, RefreshCw } from "lucide-react";
import { useMcpServer } from "../../hooks/useMcpServer";
import { MCP_TOOLS, toolsByArea } from "../../lib/mcp";
import { plural } from "../../lib/plural";
import { CodeBlock } from "../CodeBlock";
import { TabList } from "../TabList";
import { endpoint, maskToken, setupSnippets } from "../../lib/mcpServer";
import { inTauri } from "../../lib/request";
import { AgentActivity } from "./AgentActivity";

interface Props {
  /** Signed in to Spec0: the mock server tools work. */
  signedIn: boolean;
}

function CopyButton({ value, label, icon = false }: { value: string; label: string; icon?: boolean }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <button
      className={icon ? "icon-btn" : "btn sm"}
      onClick={() => void navigator.clipboard.writeText(value).then(() => setCopied(true))}
      aria-label={label}
      title={copied ? "Copied" : label}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {!icon && (copied ? " Copied" : " Copy")}
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

  const groups = toolsByArea(MCP_TOOLS);
  const [openAreas, setOpenAreas] = useState<ReadonlySet<string>>(new Set(["Requests", "Mocks"]));
  const toggleArea = (area: string) =>
    setOpenAreas((prev) => {
      const next = new Set(prev);
      if (next.has(area)) next.delete(area);
      else next.add(area);
      return next;
    });

  return (
    <div className="page-in mcp-panel">
      <div className="page-head">
        <div className="l">
          <h1 className="page-title">MCP server</h1>
          <p className="desc">
            Lets coding agents on this computer, such as Claude Code or Cursor, work with your APIs through Studio:
            read specs, send requests, run collections and start local mocks, with you approving where requests go.
          </p>
        </div>
        <div className="btn-row">
          <span className={`chip sans mcp-state${status.running ? " ok" : mcp.error ? " bad" : ""}`} role="status">
            <span className={`dot${status.running ? " live" : mcp.error ? " bad" : ""}`} aria-hidden />
            {status.running ? (
              <>
                Running on <span className="mono">:{status.port}</span>
              </>
            ) : mcp.error ? (
              "Not running"
            ) : (
              "Stopped"
            )}
          </span>
          {status.running ? (
            <button className="btn" onClick={() => void mcp.stop()} disabled={mcp.busy}>
              Stop
            </button>
          ) : (
            <button
              className="btn"
              onClick={() => void mcp.start()}
              disabled={mcp.busy || !mcp.loaded || !inTauri}
              title={inTauri ? undefined : "Needs the desktop app"}
            >
              {mcp.busy ? "Starting…" : "Start"}
            </button>
          )}
        </div>
      </div>

      {mcp.error && <div className="error-box">{mcp.error}</div>}
      {mcp.movedPort && (
        <p className="mcp-warn">
          Port {prefs.port} was in use, so the server is on {status.port}. Update your agent&apos;s settings with
          the address below, or choose another port.
        </p>
      )}

      <div className="section-head">
        <div className="l">
          <h2 className="h2">Connection</h2>
        </div>
      </div>
      <div className="rows">
        <div className="row-s">
          <div className="l">
            <b>Address</b>
          </div>
          <div className="c">
            <code className="mono">{url}</code>
            <CopyButton value={url} label="Copy address" />
          </div>
        </div>
        <div className="row-s">
          <div className="l">
            <b>Token</b>
            <span className="meta">Agents send it with every request. Making a new one stops the old one working.</span>
          </div>
          <div className="c">
            <code className="mono">{showToken ? prefs.token : maskToken(prefs.token, prefs.token)}</code>
            <button
              className="icon-btn"
              onClick={() => setShowToken((shown) => !shown)}
              aria-label={showToken ? "Hide token" : "Show token"}
              title={showToken ? "Hide token" : "Show token"}
            >
              {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
            <CopyButton value={prefs.token} label="Copy token" />
            <button
              className="btn sm"
              onClick={() => void mcp.regenerateToken()}
              disabled={mcp.busy || !mcp.loaded}
              title="Make a new token. Agents using the old one stop working."
            >
              <RefreshCw size={12} /> Regenerate
            </button>
          </div>
        </div>
        <div className="row-s">
          <div className="l">
            <b>Port</b>
            <span className="meta">If it&apos;s taken, the next free port is used.</span>
          </div>
          <div className="c">
            <input
              className="input mono mcp-port"
              inputMode="numeric"
              value={portDraft}
              onChange={(event) => setPortDraft(event.target.value.replace(/[^0-9]/g, ""))}
              onBlur={applyPort}
              onKeyDown={(event) => {
                if (event.key === "Enter") applyPort();
              }}
              aria-label="Port"
            />
          </div>
        </div>
        <div className="row-s">
          <div className="l">
            <b>Start with Studio</b>
            <span className="meta">Off unless you turn it on.</span>
          </div>
          <div className="c">
            <input
              type="checkbox"
              className="switch"
              role="switch"
              aria-label="Start the server when Studio opens"
              checked={prefs.startOnLaunch}
              onChange={(event) => void mcp.setStartOnLaunch(event.target.checked)}
            />
          </div>
        </div>
      </div>

      <div className="section-head">
        <div className="l">
          <h2 className="h2">Connect an agent</h2>
          <span className="meta">Run this once where your agent is set up. The copied text includes the token.</span>
        </div>
      </div>
      <div className="mcp-connect">
        <TabList
          className="ptabs"
          tabClassName="ptab"
          label="Agent"
          tabs={snippets.map((row) => ({ id: row.id, label: row.label }))}
          selected={snippet.id}
          onSelect={setClient}
        />
        <div className="mcp-snippet-wrap">
          <CodeBlock syntax="plain" wrap text={showToken ? snippet.text : maskToken(snippet.text, prefs.token)} />
          <span className="mcp-snippet-copy">
            <CopyButton value={snippet.text} label="Copy setup" icon />
          </span>
        </div>
      </div>

      <div className="section-head">
        <div className="l">
          <h2 className="h2">What agents can do</h2>
          <span className="meta">
            {plural(MCP_TOOLS.length, "tool")}. Studio asks you before an agent&apos;s first request to each host.
          </span>
        </div>
      </div>
      <table className="tbl mcp-tool-table">
        <colgroup>
          <col className="mcp-col-name" />
          <col />
          <col className="mcp-col-access" />
        </colgroup>
        {groups.map(({ area, tools }) => (
          <tbody key={area}>
            <tr className="clickable group-row" onClick={() => toggleArea(area)}>
              <td colSpan={3}>
                <button type="button" className="list-group" aria-expanded={openAreas.has(area)}>
                  <ChevronDown size={13} className={`group-chev${openAreas.has(area) ? "" : " shut"}`} aria-hidden />
                  {area}
                  <span className="n">{tools.length}</span>
                </button>
              </td>
            </tr>
            {openAreas.has(area) &&
              tools.map((tool) => {
                const unavailable = tool.requiresSignIn && !signedIn;
                return (
                  <tr key={tool.name} className={unavailable ? "off" : undefined} title={tool.description}>
                    <td className="mono">{tool.name}</td>
                    <td>{tool.title}</td>
                    <td className="act">
                      {tool.requiresSignIn && (
                        <span
                          className="chip sans"
                          title={unavailable ? "Sign in to Spec0 to use this" : "Uses your Spec0 sign-in"}
                        >
                          Needs sign-in
                        </span>
                      )}
                      {tool.waitsForUser && (
                        <span className="chip sans" title="Studio asks you before this sends a request or writes a file">
                          Asks you
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        ))}
      </table>

      <AgentActivity
        rules={prefs.agentRules}
        onRules={(next) => void mcp.setAgentRules(next)}
        canStop={status.running}
        busy={mcp.busy}
        onStop={() => void mcp.stopAgents()}
      />

      <p className="meta mcp-privacy">
        Only programs on this computer can connect, and only with the token. Secret variable values are filled in by
        Studio and never shared. Collections an agent makes stay drafts until you keep them. The server stops when
        Studio quits.
      </p>
    </div>
  );
}
