import {
  agentLabel,
  decide,
  DEFAULT_AGENT_RULES,
  NO_GRANTS,
  normaliseRules,
  overCapMessage,
  RateLimit,
  withAnswer,
  type AgentRules,
  type Answer,
  type Grants,
} from "./agentPolicy";
import { redact, redactDeep } from "./redact";

/**
 * The developer's side of agents working through Studio: approvals waiting for
 * an answer, what has been allowed this session, the activity log, and Stop.
 *
 * Kept in memory only, like the console: nothing here is written to disk, and
 * it is all gone when Studio quits. The rules (blocked hosts, the cap) are
 * stored with the MCP settings and handed in with `setAgentRules`.
 */

/** How long an approval waits before the request is refused. */
export const APPROVAL_TIMEOUT_MS = 5 * 60_000;
/** Activity entries kept, newest last. */
export const MAX_ACTIVITY = 200;
/** Longest response body kept in an activity entry. */
const MAX_ACTIVITY_BODY = 4000;

// Approvals

export type ApprovalKind = "request" | "changing" | "mock" | "save";

export interface Approval {
  id: number;
  /** The agent asking, as Studio names it. */
  agent: string;
  kind: ApprovalKind;
  /** One line: what the agent wants to do. */
  title: string;
  /** Details to read before answering: the method and URL, a path, a host. */
  lines: string[];
  /** The answers offered. "session" isn't offered for saving a file. */
  answers: Answer[];
  /** What "Allow for this session" covers, said plainly. */
  sessionNote?: string;
  at: string;
}

/** How an approval ended, for the tool that asked. */
export type Outcome = Answer | "timeout" | "stopped";

interface Waiting extends Approval {
  resolve: (outcome: Outcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

let waiting: Waiting[] = [];
let nextApproval = 1;
const approvalListeners = new Set<() => void>();
let approvalSnapshot: Approval[] = [];

function approvalsChanged() {
  approvalSnapshot = waiting.map(({ resolve: _resolve, timer: _timer, ...rest }) => rest);
  for (const listener of approvalListeners) listener();
}

export function subscribeApprovals(listener: () => void): () => void {
  approvalListeners.add(listener);
  return () => approvalListeners.delete(listener);
}

/** Approvals waiting, oldest first. The dialog shows the first. */
export function pendingApprovals(): Approval[] {
  return approvalSnapshot;
}

/** Ask the developer. Resolves with their answer, or how it ended without one. */
export function askDeveloper(request: Omit<Approval, "id" | "at">, timeoutMs = APPROVAL_TIMEOUT_MS): Promise<Outcome> {
  return new Promise((resolve) => {
    const id = nextApproval++;
    const timer = setTimeout(() => finish(id, "timeout"), timeoutMs);
    waiting = [...waiting, { ...request, id, at: new Date().toISOString(), resolve, timer }];
    approvalsChanged();
  });
}

function finish(id: number, outcome: Outcome) {
  const found = waiting.find((entry) => entry.id === id);
  if (!found) return;
  clearTimeout(found.timer);
  waiting = waiting.filter((entry) => entry.id !== id);
  approvalsChanged();
  found.resolve(outcome);
}

/** The developer's answer, from the dialog. */
export function answerApproval(id: number, answer: Answer): void {
  finish(id, answer);
}

// Rules and grants

let rules: AgentRules = DEFAULT_AGENT_RULES;
let grants: Grants = NO_GRANTS;
/** Whether agents may start local mocks for the rest of the session. */
let mocksAllowed = false;
const limit = new RateLimit(() => rules.maxRequestsPerMinute);

export function setAgentRules(next: Partial<AgentRules>): void {
  rules = normaliseRules(next);
}

export function agentRules(): AgentRules {
  return rules;
}

/** What has been allowed this session, for the activity view. */
export function sessionGrants(): { hosts: string[]; changing: string[]; mocks: boolean } {
  return { hosts: [...grants.hosts], changing: [...grants.changing], mocks: mocksAllowed };
}

function refusedMessage(outcome: Outcome, what: string): string {
  if (outcome === "timeout") {
    return `Studio asked the user to approve ${what}, and there was no answer within ${APPROVAL_TIMEOUT_MS / 60_000} minutes, so it wasn't done. Ask the user, then try again.`;
  }
  if (outcome === "stopped") return `The user stopped agents in Studio, so ${what} wasn't done.`;
  return `The user didn't allow ${what} in Studio.`;
}

/**
 * Whether an agent's request may go. Null when it may (asking the developer
 * first if needed); otherwise the reason it can't, for the agent to read.
 */
export async function gateRequest(agent: string, request: { method: string; url: string }): Promise<string | null> {
  const generation = stopGeneration;
  const decision = decide(request, grants, rules);
  if (decision.kind === "refuse") return decision.reason;
  if (decision.kind === "ask") {
    const where = decision.host.local ? `${decision.host.key}, on this computer` : decision.host.key;
    const outcome = await askDeveloper({
      agent,
      kind: decision.changing ? "changing" : "request",
      title: decision.changing
        ? `${agent} wants to send a ${request.method.toUpperCase()} request to ${decision.host.key}`
        : `${agent} wants to send requests to ${where}`,
      lines: [`${request.method.toUpperCase()} ${redact(request.url)}`],
      answers: ["deny", "once", "session"],
      sessionNote: decision.changing
        ? `Allows DELETE, PUT and PATCH requests to ${decision.host.key} until agents are stopped or Studio quits.`
        : decision.host.local
          ? `Allows requests to ${decision.host.key} until agents are stopped or Studio quits.`
          : `Allows requests to ${decision.host.key} until agents are stopped or Studio quits. DELETE, PUT and PATCH still ask.`,
    });
    if (generation !== stopGeneration) return refusedMessage("stopped", "this request");
    if (outcome !== "once" && outcome !== "session") {
      return refusedMessage(outcome, `sending ${request.method.toUpperCase()} requests to ${decision.host.key}`);
    }
    grants = withAnswer(grants, decision, outcome);
  }
  const wait = limit.take();
  if (wait > 0) return overCapMessage(rules.maxRequestsPerMinute, wait);
  return null;
}

/** Whether an agent may start a local mock. Starting one opens a port, so the developer says so. */
export async function gateMockStart(agent: string, api: string): Promise<string | null> {
  if (mocksAllowed) return null;
  const generation = stopGeneration;
  const outcome = await askDeveloper({
    agent,
    kind: "mock",
    title: `${agent} wants to start a local mock of ${api}`,
    lines: ["It listens on 127.0.0.1, on this computer only, and answers with examples from the spec."],
    answers: ["deny", "once", "session"],
    sessionNote: "Lets agents start local mocks until agents are stopped or Studio quits.",
  });
  if (generation !== stopGeneration) return refusedMessage("stopped", "starting the mock");
  if (outcome === "session") mocksAllowed = true;
  return outcome === "once" || outcome === "session" ? null : refusedMessage(outcome, `starting a local mock of ${api}`);
}

/** Whether an agent may write a collection to a file. Asked every time. */
export async function gateSave(agent: string, collection: string, path: string, replaces: boolean): Promise<string | null> {
  const generation = stopGeneration;
  const outcome = await askDeveloper({
    agent,
    kind: "save",
    title: `${agent} wants to save “${collection}” to a file`,
    lines: [path, replaces ? "A file is already there. Saving replaces it." : "Saving keeps the collection: it stops being a draft."],
    answers: ["deny", "once"],
  });
  if (generation !== stopGeneration) return refusedMessage("stopped", "saving the file");
  return outcome === "once" ? null : refusedMessage(outcome, `saving the collection to ${path}`);
}

// Stopping

let stopGeneration = 0;
const stopListeners = new Set<() => void>();

/** Bumped by Stop agents; work started before compares against it to know it should end. */
export function currentStopGeneration(): number {
  return stopGeneration;
}

export function onAgentsStopped(listener: () => void): () => void {
  stopListeners.add(listener);
  return () => stopListeners.delete(listener);
}

/**
 * Stop agents: refuse every approval still waiting, forget what was allowed
 * this session, and tell runs started by agents to stop. The caller stops the
 * server too, which answers any call still in flight.
 */
export function stopAgents(): void {
  stopGeneration += 1;
  for (const entry of [...waiting]) finish(entry.id, "stopped");
  grants = NO_GRANTS;
  mocksAllowed = false;
  limit.reset();
  for (const listener of stopListeners) listener();
  recordActivity({ agent: "Studio", tool: "stop", ok: true, summary: "Agents stopped. Approvals for this session were cleared." });
}

// Agents seen and what they did

export interface ConnectedAgent {
  name: string;
  version?: string;
  since: string;
  lastSeen: string;
}

export interface ActivityEntry {
  id: number;
  at: string;
  agent: string;
  tool: string;
  ok: boolean;
  /** One line: what happened. */
  summary: string;
  /** A request sent for the agent, redacted. */
  sent?: { method: string; url: string; headers?: Record<string, string>; body?: string };
  /** What came back, redacted and cut short. */
  received?: { status: number; ms?: number; bytes?: number; body?: string };
}

let activity: ActivityEntry[] = [];
let agents: ConnectedAgent[] = [];
let nextActivity = 1;
const activityListeners = new Set<() => void>();
let activitySnapshot = { activity, agents };

function activityChanged() {
  activitySnapshot = { activity, agents };
  for (const listener of activityListeners) listener();
}

export function subscribeActivity(listener: () => void): () => void {
  activityListeners.add(listener);
  return () => activityListeners.delete(listener);
}

export function activityState(): { activity: ActivityEntry[]; agents: ConnectedAgent[] } {
  return activitySnapshot;
}

function clip(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  return text.length > MAX_ACTIVITY_BODY ? `${text.slice(0, MAX_ACTIVITY_BODY - 1)}…` : text;
}

/** Add to the activity log. Redacted here, so no caller can forget to. */
export function recordActivity(input: Omit<ActivityEntry, "id" | "at"> & { at?: string }): void {
  const clean = redactDeep({
    ...input,
    ...(input.sent ? { sent: { ...input.sent, body: clip(input.sent.body) } } : {}),
    ...(input.received ? { received: { ...input.received, body: clip(input.received.body) } } : {}),
  });
  const entry: ActivityEntry = { ...clean, id: nextActivity++, at: input.at ?? new Date().toISOString() };
  const all = [...activity, entry];
  activity = all.length > MAX_ACTIVITY ? all.slice(all.length - MAX_ACTIVITY) : all;
  const seen = agents.find((row) => row.name === entry.agent);
  if (seen) agents = agents.map((row) => (row === seen ? { ...row, lastSeen: entry.at } : row));
  activityChanged();
}

/** A client finished `initialize`. */
export function noteAgent(client: { name?: string | null; version?: string | null }): void {
  const name = agentLabel(client);
  const now = new Date().toISOString();
  const existing = agents.find((row) => row.name === name);
  agents = existing
    ? agents.map((row) => (row === existing ? { ...row, lastSeen: now, ...(client.version ? { version: client.version } : {}) } : row))
    : [...agents, { name, ...(client.version ? { version: client.version } : {}), since: now, lastSeen: now }];
  activityChanged();
}

export function clearActivity(): void {
  activity = [];
  activityChanged();
}

/** For tests: back to a fresh session. */
export function resetAgentControl(): void {
  for (const entry of waiting) clearTimeout(entry.timer);
  waiting = [];
  approvalsChanged();
  grants = NO_GRANTS;
  mocksAllowed = false;
  rules = DEFAULT_AGENT_RULES;
  limit.reset();
  activity = [];
  agents = [];
  nextActivity = 1;
  activityChanged();
}
