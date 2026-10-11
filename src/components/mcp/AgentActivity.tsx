import { useEffect, useState, useSyncExternalStore } from "react";
import { activityState, clearActivity, sessionGrants, subscribeActivity, type ActivityEntry } from "../../lib/agentControl";
import {
  MAX_REQUESTS_PER_MINUTE,
  MIN_REQUESTS_PER_MINUTE,
  normaliseHostPattern,
  type AgentRules,
} from "../../lib/agentPolicy";

interface Props {
  rules: AgentRules;
  onRules: (rules: AgentRules) => void;
  /** The server is running, or something is waiting: Stop has something to stop. */
  canStop: boolean;
  busy: boolean;
  onStop: () => void;
}

function time(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function Entry({ entry }: { entry: ActivityEntry }) {
  const detail = entry.sent || entry.received;
  const line = (
    <>
      <span className="agent-time">{time(entry.at)}</span>
      <span className="agent-name">{entry.agent}</span>
      <code className="agent-tool">{entry.tool}</code>
      <span className={`agent-summary${entry.ok ? "" : " bad"}`}>{entry.summary}</span>
    </>
  );
  if (!detail) return <li className="agent-entry plain">{line}</li>;
  return (
    <li className="agent-entry">
      <details>
        <summary>{line}</summary>
        <div className="agent-detail">
          {entry.sent && (
            <>
              <span className="mcp-label">Sent</span>
              <pre className="code">
                {`${entry.sent.method} ${entry.sent.url}`}
                {entry.sent.headers
                  ? `\n${Object.entries(entry.sent.headers)
                      .map(([name, value]) => `${name}: ${value}`)
                      .join("\n")}`
                  : ""}
                {entry.sent.body ? `\n\n${entry.sent.body}` : ""}
              </pre>
            </>
          )}
          {entry.received && (
            <>
              <span className="mcp-label">Received</span>
              <pre className="code">
                {`${entry.received.status}${entry.received.ms !== undefined ? ` · ${entry.received.ms} ms` : ""}${
                  entry.received.bytes !== undefined ? ` · ${entry.received.bytes} bytes` : ""
                }`}
                {entry.received.body ? `\n\n${entry.received.body}` : ""}
              </pre>
            </>
          )}
        </div>
      </details>
    </li>
  );
}

/**
 * What agents may do and what they did: who is connected, what was allowed
 * this session, the rules (blocked hosts, the cap), the activity log and Stop.
 * The log is in memory only and redacted, like the console.
 */
export function AgentActivity({ rules, onRules, canStop, busy, onStop }: Props) {
  const { activity, agents } = useSyncExternalStore(subscribeActivity, activityState);
  const grants = sessionGrants();
  const [blockedDraft, setBlockedDraft] = useState(rules.blockedHosts.join("\n"));
  const [capDraft, setCapDraft] = useState(String(rules.maxRequestsPerMinute));
  const [blockedNote, setBlockedNote] = useState<string | null>(null);

  useEffect(() => setBlockedDraft(rules.blockedHosts.join("\n")), [rules.blockedHosts]);
  useEffect(() => setCapDraft(String(rules.maxRequestsPerMinute)), [rules.maxRequestsPerMinute]);

  const applyBlocked = () => {
    const lines = blockedDraft.split(/[\n,]+/).map((line) => line.trim()).filter(Boolean);
    const kept = lines.map(normaliseHostPattern).filter((pattern): pattern is string => Boolean(pattern));
    const dropped = lines.filter((line) => !normaliseHostPattern(line));
    setBlockedNote(dropped.length ? `Not hosts, so left out: ${dropped.join(", ")}` : null);
    onRules({ ...rules, blockedHosts: [...new Set(kept)] });
  };

  const applyCap = () => {
    const value = Number(capDraft);
    if (!Number.isFinite(value) || value < MIN_REQUESTS_PER_MINUTE) {
      setCapDraft(String(rules.maxRequestsPerMinute));
      return;
    }
    onRules({ ...rules, maxRequestsPerMinute: Math.min(MAX_REQUESTS_PER_MINUTE, Math.round(value)) });
  };

  const newest = [...activity].reverse();

  return (
    <section className="agent-activity" aria-labelledby="agent-activity-title">
      <div className="mcp-row">
        <h4 className="mcp-heading" id="agent-activity-title">
          Agents
        </h4>
        <span className="spacer" />
        <button
          className="btn"
          onClick={onStop}
          disabled={busy || !canStop}
          title="Refuse everything agents are waiting for, stop runs they started, forget what was allowed this session, and stop the server"
        >
          Stop agents
        </button>
      </div>

      <p className="field-meta">
        Agents can send requests and run collections through Studio. The first request to each host asks you here,
        and DELETE, PUT and PATCH to hosts outside this computer ask separately.
      </p>

      {agents.length > 0 ? (
        <ul className="agent-list">
          {agents.map((agent) => (
            <li key={agent.name}>
              <strong>{agent.name}</strong>
              {agent.version && <span className="field-meta"> {agent.version}</span>}
              <span className="field-meta"> · last seen {time(agent.lastSeen)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="field-meta">No agent has connected since Studio started.</p>
      )}

      {(grants.hosts.length > 0 || grants.mocks) && (
        <p className="field-meta">
          Allowed this session:{" "}
          {[
            ...grants.hosts.map((host) => (grants.changing.includes(host) ? `${host} (including DELETE, PUT and PATCH)` : host)),
            ...(grants.mocks ? ["starting local mocks"] : []),
          ].join(", ")}
          .
        </p>
      )}

      <div className="mcp-grid">
        <span className="mcp-label">Blocked hosts</span>
        <div className="mcp-value agent-blocked">
          <textarea
            className="mono"
            rows={3}
            value={blockedDraft}
            placeholder={"api.example.com\n*.prod.example.com"}
            onChange={(event) => setBlockedDraft(event.target.value)}
            onBlur={applyBlocked}
            aria-label="Hosts agents can never send to, one per line"
          />
          <span className="field-meta">
            Agents can never send to these, and Studio doesn&apos;t ask. One per line; <code>*.</code> covers a domain
            and everything under it.
          </span>
          {blockedNote && <span className="mcp-warn">{blockedNote}</span>}
        </div>

        <span className="mcp-label">Requests a minute</span>
        <div className="mcp-value">
          <input
            className="mcp-port"
            inputMode="numeric"
            value={capDraft}
            onChange={(event) => setCapDraft(event.target.value.replace(/[^0-9]/g, ""))}
            onBlur={applyCap}
            onKeyDown={(event) => {
              if (event.key === "Enter") applyCap();
            }}
            aria-label="Requests agents can send per minute"
          />
          <span className="field-meta">For all agents together. Over it, a request is refused and the agent is told to wait.</span>
        </div>
      </div>

      <div className="mcp-row">
        <h4 className="mcp-heading">Activity</h4>
        <span className="spacer" />
        {activity.length > 0 && (
          <button className="btn ghost" onClick={clearActivity}>
            Clear
          </button>
        )}
      </div>
      {newest.length ? (
        <ul className="agent-log">
          {newest.map((entry) => (
            <Entry key={entry.id} entry={entry} />
          ))}
        </ul>
      ) : (
        <p className="field-meta">What agents ask for and what Studio sends for them shows here, for this session only.</p>
      )}
    </section>
  );
}
