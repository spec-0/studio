/**
 * What an agent may send through Studio, and when Studio asks the developer
 * first. Plain rules, no React and no IO; `agentControl.ts` holds the state.
 *
 * - A host the developer hasn't approved is asked about, the first time.
 *   Hosts on this computer (`localhost`, `127.0.0.1`, `[::1]`, which is where
 *   local mocks run) can be allowed for the rest of the session in one answer.
 *   So can other hosts, but that is always a separate, deliberate answer.
 * - `DELETE`, `PUT` and `PATCH` to a host outside this computer need their own
 *   approval, even when the host is already allowed: they are the requests that
 *   change or remove data somewhere that isn't the developer's own machine.
 * - A blocked host is refused without asking.
 * - There is a cap on requests per minute, so an agent in a loop can't flood a
 *   service. Over the cap, a request is refused with how long to wait.
 *
 * "For this session" means until the MCP server stops, the developer presses
 * Stop agents, or Studio quits. Nothing here is written to disk.
 */

/** Methods that change or remove data, which need their own approval for a host outside this computer. */
export const CHANGING_METHODS = ["DELETE", "PUT", "PATCH"];

export interface AgentRules {
  /** Hosts agents can never send to: `api.example.com`, `*.example.com`, `example.com:8443`. */
  blockedHosts: string[];
  /** Requests agents can send per minute, across all agents. */
  maxRequestsPerMinute: number;
}

export const DEFAULT_AGENT_RULES: AgentRules = { blockedHosts: [], maxRequestsPerMinute: 60 };
export const MIN_REQUESTS_PER_MINUTE = 1;
export const MAX_REQUESTS_PER_MINUTE = 600;

/** Rules as stored, made safe to use: patterns cleaned up, the cap within bounds. */
export function normaliseRules(stored: Partial<AgentRules> | undefined): AgentRules {
  const blocked = Array.isArray(stored?.blockedHosts) ? stored.blockedHosts : [];
  const patterns = [...new Set(blocked.map((value) => normaliseHostPattern(String(value))).filter((p): p is string => Boolean(p)))];
  const cap = stored?.maxRequestsPerMinute;
  return {
    blockedHosts: patterns,
    maxRequestsPerMinute:
      typeof cap === "number" && Number.isFinite(cap)
        ? Math.min(MAX_REQUESTS_PER_MINUTE, Math.max(MIN_REQUESTS_PER_MINUTE, Math.round(cap)))
        : DEFAULT_AGENT_RULES.maxRequestsPerMinute,
  };
}

// Hosts

export interface RequestHost {
  /** Lower-cased host name, without brackets for IPv6. */
  hostname: string;
  /** The port, written out even when it is the scheme's default. */
  port: string;
  /** `hostname:port`, how approvals are kept. IPv6 hosts keep their brackets. */
  key: string;
  local: boolean;
}

/** The host a URL goes to, or null when it isn't an http(s) URL. */
export function requestHost(url: string): RequestHost | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const bracketed = parsed.hostname.toLowerCase();
  const hostname = bracketed.replace(/^\[|\]$/g, "");
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  return { hostname, port, key: `${bracketed}:${port}`, local: isLocalHostname(hostname) };
}

/** `localhost`, a `.localhost` name, `127.x.x.x` or `::1`: this computer. */
export function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * A blocked-host entry as it is kept: lower case, no scheme or path. `*.` in
 * front matches the domain and anything under it; `:port` limits it to a port.
 * Null when it isn't a host.
 */
export function normaliseHostPattern(text: string): string | null {
  let value = text.trim().toLowerCase();
  if (!value) return null;
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[/?#].*$/, "");
  const wildcard = value.startsWith("*.");
  if (wildcard) value = value.slice(2);
  const match = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/.exec(value);
  if (!match || match[1].startsWith(".") || match[1].endsWith(".") || match[1] === "") return null;
  return `${wildcard ? "*." : ""}${match[1]}${match[2] ? `:${match[2]}` : ""}`;
}

/** The blocked-host entry a URL matches, or null. */
export function blockedBy(url: string, patterns: readonly string[]): string | null {
  const host = requestHost(url);
  if (!host) return null;
  for (const pattern of patterns) {
    const [, name, port] = /^(?:\*\.)?(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(pattern) ?? [];
    if (!name) continue;
    const bare = name.replace(/^\[|\]$/g, "");
    if (port && port !== host.port) continue;
    const matches = pattern.startsWith("*.")
      ? host.hostname === bare || host.hostname.endsWith(`.${bare}`)
      : host.hostname === bare;
    if (matches) return pattern;
  }
  return null;
}

// Deciding

/** What the developer has allowed for this session. */
export interface Grants {
  /** Host keys any request may go to (for a host outside this computer, except DELETE, PUT and PATCH). */
  hosts: ReadonlySet<string>;
  /** Host keys outside this computer that DELETE, PUT and PATCH may go to. */
  changing: ReadonlySet<string>;
}

export const NO_GRANTS: Grants = { hosts: new Set(), changing: new Set() };

export type Decision =
  | { kind: "allow" }
  | { kind: "refuse"; reason: string }
  | {
      kind: "ask";
      host: RequestHost;
      /** A DELETE, PUT or PATCH to a host outside this computer. */
      changing: boolean;
    };

export function needsOwnApproval(method: string, host: RequestHost): boolean {
  return !host.local && CHANGING_METHODS.includes(method.toUpperCase());
}

/** Whether a request can go now, must be refused, or needs the developer's answer. */
export function decide(request: { method: string; url: string }, grants: Grants, rules: AgentRules): Decision {
  const host = requestHost(request.url);
  if (!host) return { kind: "refuse", reason: `Studio only sends http and https requests, not ${request.url}.` };
  const blocked = blockedBy(request.url, rules.blockedHosts);
  if (blocked) {
    return {
      kind: "refuse",
      reason: `The user has blocked agents from sending requests to ${blocked} in Studio's MCP settings.`,
    };
  }
  const changing = needsOwnApproval(request.method, host);
  if (changing ? grants.changing.has(host.key) : grants.hosts.has(host.key)) return { kind: "allow" };
  return { kind: "ask", host, changing };
}

/** The developer's answer to an approval. */
export type Answer = "once" | "session" | "deny";

/** The grants after an answer. "Once" and "deny" leave them as they were. */
export function withAnswer(grants: Grants, decision: Extract<Decision, { kind: "ask" }>, answer: Answer): Grants {
  if (answer !== "session") return grants;
  const key = decision.host.key;
  return decision.changing
    ? { hosts: new Set([...grants.hosts, key]), changing: new Set([...grants.changing, key]) }
    : { hosts: new Set([...grants.hosts, key]), changing: grants.changing };
}

// The cap

/**
 * Requests per minute, over a sliding minute. `take` either counts a request
 * and returns 0, or returns how many milliseconds until one can go.
 */
export class RateLimit {
  private sent: number[] = [];

  constructor(private perMinute: () => number) {}

  take(now = Date.now()): number {
    const windowStart = now - 60_000;
    this.sent = this.sent.filter((at) => at > windowStart);
    if (this.sent.length >= this.perMinute()) return this.sent[0] + 60_000 - now;
    this.sent.push(now);
    return 0;
  }

  reset(): void {
    this.sent = [];
  }
}

/** What a refused request over the cap says. */
export function overCapMessage(perMinute: number, waitMs: number): string {
  const seconds = Math.max(1, Math.ceil(waitMs / 1000));
  return `Studio's limit for agent requests (${perMinute} a minute) was reached, so this one wasn't sent. Try again in ${seconds} second${seconds === 1 ? "" : "s"}. The user can change the limit in Studio's MCP settings.`;
}

// Names

const KNOWN_AGENTS: Record<string, string> = {
  "claude-code": "Claude Code",
  "claude-ai": "Claude",
  claude: "Claude",
  cursor: "Cursor",
  "cursor-vscode": "Cursor",
  codex: "Codex",
  "codex-mcp-client": "Codex",
  windsurf: "Windsurf",
  "visual-studio-code": "VS Code",
  vscode: "VS Code",
  zed: "Zed",
  "gemini-cli-mcp-client": "Gemini CLI",
  "gemini-cli": "Gemini CLI",
};

/** How an agent is named in Studio: its client's name, made readable. */
export function agentLabel(agent: { name?: string | null } | null | undefined): string {
  const name = agent?.name?.trim();
  if (!name) return "An unnamed agent";
  return KNOWN_AGENTS[name.toLowerCase()] ?? name;
}
