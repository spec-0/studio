/**
 * What the bell in the top bar shows: agent requests waiting for an answer,
 * requests nobody answered, updates that a check found, and collection runs an
 * agent started that have finished.
 *
 * Kept in memory for the session only, like the console. Nothing here makes a
 * request: it only collects what Studio already knows. The functions that
 * change the state are pure; the store at the bottom holds one state and tells
 * subscribers when it changes.
 */

/** Where a waiting request came from: an MCP tool's approval, or the agent chat's permission question. */
export type RequestSource = "mcp" | "chat";

export type NotificationKind = "request" | "missed" | "studio-update" | "api-update" | "run-finished";

/** A way to answer a waiting request, as the bell's button shows it. */
export interface RequestAnswer {
  id: string;
  label: string;
  /** The first way to allow is the primary button; refusals sit apart. */
  tone: "primary" | "allow" | "deny";
}

/** What a notification's link does. Plain data; the bell turns it into a callback. */
export type NotificationAction =
  | { kind: "open-mcp" }
  | { kind: "open-chat" }
  | { kind: "studio-update" }
  | { kind: "api-update"; entryId: string }
  | { kind: "open-run"; collectionId: string; runId: string };

export interface Notification {
  /** Stable for the same thing, so a sync doesn't duplicate it. */
  id: string;
  kind: NotificationKind;
  /** When it happened, as an ISO string. */
  at: string;
  /** One line: what it is. */
  title: string;
  /** Short lines under the title: a URL, a path, a reason. */
  lines: string[];
  /** The agent that asked, or that started the run. */
  agent?: string;
  /** Waiting requests: where to send the answer, and the answers offered. */
  source?: RequestSource;
  sourceId?: string;
  answers?: RequestAnswer[];
  /** A finished run: whether it passed. */
  passed?: boolean;
  action?: NotificationAction;
}

export interface NotificationState {
  items: Notification[];
  /**
   * Ids dismissed this session, for items that a sync would otherwise bring
   * back: an update stays dismissed until a later check finds it again.
   */
  dismissed: ReadonlySet<string>;
}

export const EMPTY_NOTIFICATIONS: NotificationState = { items: [], dismissed: new Set() };

/** Missed requests and finished runs kept, newest first. Older ones drop off. */
export const MAX_KEPT = 50;

const newestFirst = (a: Notification, b: Notification) => b.at.localeCompare(a.at);

function keepNewest(items: Notification[]): Notification[] {
  const pending = items.filter((item) => item.kind === "request");
  const rest = items.filter((item) => item.kind !== "request").sort(newestFirst);
  return [...pending, ...rest.slice(0, MAX_KEPT)];
}

// Changing the state

/** Replace the waiting requests from one source with what it says is waiting now. */
export function withPending(state: NotificationState, source: RequestSource, requests: Notification[]): NotificationState {
  const others = state.items.filter((item) => !(item.kind === "request" && item.source === source));
  const mine = requests.map((request) => ({ ...request, kind: "request" as const, source }));
  return { ...state, items: [...others, ...mine] };
}

/** Add an event: a request nobody answered, or a run that finished. The same id twice is kept once. */
export function withEvent(state: NotificationState, event: Notification): NotificationState {
  if (state.items.some((item) => item.id === event.id) || state.dismissed.has(event.id)) return state;
  return { ...state, items: keepNewest([...state.items, event]) };
}

/** The Studio update the last check found, or null when it found none. */
export function withStudioUpdate(
  state: NotificationState,
  update: { version: string; currentVersion: string } | null,
  at: string,
): NotificationState {
  const items = state.items.filter((item) => item.kind !== "studio-update");
  if (!update) return { ...state, items };
  const id = `studio-update:${update.version}`;
  if (state.dismissed.has(id)) return { ...state, items };
  const existing = state.items.find((item) => item.id === id);
  return {
    ...state,
    items: [
      ...items,
      existing ?? {
        id,
        kind: "studio-update",
        at,
        title: `Studio ${update.version} is available`,
        lines: [`You have ${update.currentVersion}.`],
        action: { kind: "studio-update" },
      },
    ],
  };
}

/** An API in the library with a newer version upstream, as the last check marked it. */
export interface ApiUpdateMark {
  entryId: string;
  title: string;
  version?: string | null;
  /** When the check ran: a later check brings a dismissed one back. */
  checkedAt: string;
}

/** Replace the API updates with what the library is marked with now. */
export function withApiUpdates(state: NotificationState, marks: readonly ApiUpdateMark[]): NotificationState {
  const items = state.items.filter((item) => item.kind !== "api-update");
  const updates = marks
    .map((mark): Notification => ({
      id: `api-update:${mark.entryId}:${mark.checkedAt}`,
      kind: "api-update",
      at: mark.checkedAt,
      title: `${mark.title} has a newer version${mark.version ? `: ${mark.version}` : ""}`,
      lines: ["From its source in Spec0. Your copy stays as it is until you update it."],
      action: { kind: "api-update", entryId: mark.entryId },
    }))
    .filter((item) => !state.dismissed.has(item.id));
  return { ...state, items: [...items, ...updates] };
}

/** Dismiss one item. A waiting request can't be dismissed, only answered. */
export function withDismissed(state: NotificationState, id: string): NotificationState {
  const found = state.items.find((item) => item.id === id);
  if (!found || found.kind === "request") return state;
  return {
    items: state.items.filter((item) => item.id !== id),
    dismissed: new Set([...state.dismissed, id]),
  };
}

/** Dismiss everything except the requests still waiting. */
export function withAllDismissed(state: NotificationState): NotificationState {
  const gone = state.items.filter((item) => item.kind !== "request");
  if (!gone.length) return state;
  return {
    items: state.items.filter((item) => item.kind === "request"),
    dismissed: new Set([...state.dismissed, ...gone.map((item) => item.id)]),
  };
}

// Reading the state

export interface NotificationSections {
  waiting: Notification[];
  missed: Notification[];
  updates: Notification[];
  finished: Notification[];
}

/** The bell's sections, each newest first. */
export function sections(state: NotificationState): NotificationSections {
  const of = (...kinds: NotificationKind[]) =>
    state.items.filter((item) => kinds.includes(item.kind)).sort(newestFirst);
  return {
    waiting: of("request"),
    missed: of("missed"),
    updates: of("studio-update", "api-update"),
    finished: of("run-finished"),
  };
}

export function waitingCount(state: NotificationState): number {
  return state.items.filter((item) => item.kind === "request").length;
}

/** The bell's accessible label: what it holds, the waiting requests first. */
export function bellLabel(state: NotificationState): string {
  const waiting = waitingCount(state);
  const others = state.items.length - waiting;
  const parts: string[] = [];
  if (waiting) parts.push(`${waiting} ${waiting === 1 ? "request" : "requests"} waiting for you`);
  if (others) parts.push(`${others} ${others === 1 ? "other" : "others"}`);
  return parts.length ? `Notifications: ${parts.join(", ")}` : "Notifications";
}

/** The window's title: Studio's name, and how many requests wait when any do. */
export function attentionTitle(base: string, waiting: number): string {
  if (!waiting) return base;
  return `${base} — ${waiting} ${waiting === 1 ? "request" : "requests"} waiting`;
}

// What each source turns into

/** An MCP tool's approval, as it waits in the bell. */
export function mcpRequest(approval: {
  id: number;
  agent: string;
  title: string;
  lines: string[];
  answers: string[];
  at: string;
}): Notification {
  const labels: Record<string, string> = { deny: "Don't allow", once: "Allow once", session: "Allow for this session" };
  return {
    id: `mcp:${approval.id}`,
    kind: "request",
    at: approval.at,
    title: approval.title,
    lines: approval.lines.slice(0, 1),
    agent: approval.agent,
    source: "mcp",
    sourceId: String(approval.id),
    // The same primary as the dialog: "for this session" when it's offered, otherwise "once".
    answers: approval.answers.map((answer) => ({
      id: answer,
      label: labels[answer] ?? answer,
      tone:
        answer === "deny"
          ? "deny"
          : answer === (approval.answers.includes("session") ? "session" : "once")
            ? "primary"
            : "allow",
    })),
  };
}

/** Why an MCP approval ended without an answer, or null when it was answered. */
export function mcpMissed(
  approval: { id: number; agent: string; title: string; lines: string[] },
  outcome: string,
  at: string,
  timeoutMinutes: number,
): Notification | null {
  if (outcome !== "timeout" && outcome !== "stopped") return null;
  return {
    id: `missed:mcp:${approval.id}`,
    kind: "missed",
    at,
    title: approval.title,
    lines: [
      outcome === "timeout"
        ? `Nobody answered within ${timeoutMinutes} minutes, so it was refused and the agent was told.`
        : "Refused because agents were stopped.",
      ...approval.lines.slice(0, 1),
    ],
    agent: approval.agent,
    action: { kind: "open-mcp" },
  };
}

/** The agent chat's permission question, as the chat holds it. */
export interface ChatPermission {
  id: string;
  title: string;
  state: "pending" | "answered" | "cancelled";
  options: { optionId: string; name: string; kind: string }[];
}

/**
 * The chat's permission questions, as the bell shows them: those still
 * waiting, and those the bell had waiting that ended without an answer (the
 * chat was stopped, a new one started, or the agent ended).
 */
export function chatChanges(
  items: readonly ChatPermission[],
  agent: string,
  wasWaiting: readonly Notification[],
  at: string,
): { waiting: Notification[]; missed: Notification[] } {
  const waiting = items
    .filter((item) => item.state === "pending")
    .map((item): Notification => {
      const allows = item.options.filter((option) => option.kind.startsWith("allow"));
      const rejects = item.options.filter((option) => !option.kind.startsWith("allow"));
      return {
        id: `chat:${item.id}`,
        kind: "request",
        at,
        title: item.title,
        lines: ["Asked in the agent chat."],
        agent,
        source: "chat",
        sourceId: item.id,
        answers: [
          ...allows.map((option, index) => ({
            id: option.optionId,
            label: option.name,
            tone: index === 0 ? ("primary" as const) : ("allow" as const),
          })),
          ...rejects.map((option) => ({ id: option.optionId, label: option.name, tone: "deny" as const })),
        ],
      };
    });
  const byId = new Map(items.map((item) => [`chat:${item.id}`, item]));
  const missed = wasWaiting
    .filter((before) => {
      const now = byId.get(before.id);
      return !now || now.state === "cancelled";
    })
    .map((before): Notification => ({
      id: `missed:${before.id}`,
      kind: "missed",
      at,
      title: before.title,
      lines: ["The chat stopped before it was answered, so the agent didn't go ahead."],
      agent: before.agent,
      action: { kind: "open-chat" },
    }));
  return { waiting, missed };
}

/** The chat's requests the bell has waiting now. */
export function waitingFrom(state: NotificationState, source: RequestSource): Notification[] {
  return state.items.filter((item) => item.kind === "request" && item.source === source);
}

/** A collection run an agent started, once it has finished. Runs you start yourself aren't added. */
export function runFinishedNotice(
  notice: { collectionId: string; runId: string; name: string; passed: boolean; text: string; startedBy?: string },
  at: string,
): Notification | null {
  if (!notice.startedBy) return null;
  return {
    id: `run:${notice.collectionId}:${notice.runId}`,
    kind: "run-finished",
    at,
    title: `${notice.name} ${notice.passed ? "passed" : "didn't pass"}`,
    lines: [notice.text],
    agent: notice.startedBy,
    passed: notice.passed,
    action: { kind: "open-run", collectionId: notice.collectionId, runId: notice.runId },
  };
}

// The store

let state: NotificationState = EMPTY_NOTIFICATIONS;
const listeners = new Set<() => void>();

function set(next: NotificationState): void {
  if (next === state) return;
  state = next;
  for (const listener of listeners) listener();
}

export function subscribeNotifications(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The current state. A new object only when something changed. */
export function notificationState(): NotificationState {
  return state;
}

export function setPendingRequests(source: RequestSource, requests: Notification[]): void {
  // Keep the time a request first appeared, so a sync doesn't make it look new.
  const at = new Map(state.items.map((item) => [item.id, item.at]));
  const next = requests.map((request) => ({ ...request, at: at.get(request.id) ?? request.at }));
  const current = state.items.filter((item) => item.kind === "request" && item.source === source);
  if (sameRequests(current, next)) return;
  set(withPending(state, source, next));
}

function sameRequests(a: Notification[], b: Notification[]): boolean {
  return a.length === b.length && a.every((item, index) => item.id === b[index].id && item.title === b[index].title);
}

export function addNotification(event: Notification): void {
  set(withEvent(state, event));
}

export function setStudioUpdate(update: { version: string; currentVersion: string } | null): void {
  set(withStudioUpdate(state, update, new Date().toISOString()));
}

export function setApiUpdates(marks: readonly ApiUpdateMark[]): void {
  const current = state.items.filter((item) => item.kind === "api-update").map((item) => item.id);
  const next = marks.map((mark) => `api-update:${mark.entryId}:${mark.checkedAt}`).filter((id) => !state.dismissed.has(id));
  if (current.length === next.length && current.every((id, index) => id === next[index])) return;
  set(withApiUpdates(state, marks));
}

export function dismissNotification(id: string): void {
  set(withDismissed(state, id));
}

export function dismissAllNotifications(): void {
  set(withAllDismissed(state));
}

// Answering a waiting request from the bell

type Answerer = (sourceId: string, answerId: string) => void;
const answerers = new Map<RequestSource, Answerer>();

/** Each source says how to answer its requests: the MCP approvals, and the open chat. */
export function setRequestAnswerer(source: RequestSource, answerer: Answerer | null): void {
  if (answerer) answerers.set(source, answerer);
  else answerers.delete(source);
}

/** Answer a waiting request, the same as answering it where it was asked. */
export function answerRequest(id: string, answerId: string): void {
  const found = state.items.find((item) => item.id === id && item.kind === "request");
  if (!found?.source || found.sourceId === undefined) return;
  answerers.get(found.source)?.(found.sourceId, answerId);
}

/** For tests: back to an empty session. */
export function resetNotifications(): void {
  answerers.clear();
  set(EMPTY_NOTIFICATIONS);
}
