/**
 * The bell: agent requests waiting for an answer, ones nobody answered,
 * updates a check found, and runs agents started. Kept for the session only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { answerApproval, askDeveloper, onApprovalEnded, pendingApprovals, resetAgentControl, stopAgents } from "../agentControl";
import {
  EMPTY_NOTIFICATIONS,
  MAX_KEPT,
  addNotification,
  answerRequest,
  attentionTitle,
  bellLabel,
  chatChanges,
  dismissAllNotifications,
  dismissNotification,
  mcpMissed,
  mcpRequest,
  notificationState,
  resetNotifications,
  runFinishedNotice,
  sections,
  setApiUpdates,
  setPendingRequests,
  setRequestAnswerer,
  setStudioUpdate,
  subscribeNotifications,
  waitingCount,
  waitingFrom,
  withEvent,
  type ChatPermission,
  type Notification,
} from "../notifications";

afterEach(() => {
  resetNotifications();
  resetAgentControl();
  vi.useRealTimers();
});

const approval = {
  id: 7,
  agent: "Claude Code",
  title: "Claude Code wants to add a spec to the library",
  lines: ["https://example.com/openapi.yaml", "Studio fetches it with one GET request."],
  answers: ["deny", "once"],
  at: "2026-11-24T10:00:00.000Z",
};

const event = (id: string, at: string, kind: Notification["kind"] = "missed"): Notification => ({
  id,
  kind,
  at,
  title: id,
  lines: [],
});

describe("an agent's request waiting for an answer", () => {
  it("shows what it wants, which agent, and the dialog's answers", () => {
    const item = mcpRequest(approval);
    expect(item).toMatchObject({
      id: "mcp:7",
      kind: "request",
      title: approval.title,
      agent: "Claude Code",
      lines: ["https://example.com/openapi.yaml"],
      source: "mcp",
      sourceId: "7",
    });
    expect(item.answers).toEqual([
      { id: "deny", label: "Don't allow", tone: "deny" },
      { id: "once", label: "Allow once", tone: "primary" },
    ]);
    // Where "for this session" is offered, it's the primary, as in the dialog.
    expect(mcpRequest({ ...approval, answers: ["deny", "once", "session"] }).answers?.map((a) => a.tone)).toEqual([
      "deny",
      "allow",
      "primary",
    ]);
  });

  it("can't be dismissed, one by one or all at once, only answered", () => {
    setPendingRequests("mcp", [mcpRequest(approval)]);
    addNotification(event("missed:1", "2026-11-24T09:00:00.000Z"));
    dismissNotification("mcp:7");
    expect(waitingCount(notificationState())).toBe(1);
    dismissAllNotifications();
    expect(notificationState().items.map((item) => item.id)).toEqual(["mcp:7"]);
  });

  it("is answered through its source, the same as in the dialog", () => {
    const answered: string[] = [];
    setRequestAnswerer("mcp", (id, answer) => answered.push(`${id}:${answer}`));
    setPendingRequests("mcp", [mcpRequest(approval)]);
    answerRequest("mcp:7", "once");
    answerRequest("mcp:999", "once");
    expect(answered).toEqual(["7:once"]);
  });

  it("goes when its source says it's no longer waiting, and keeps the time it first appeared", () => {
    setPendingRequests("mcp", [mcpRequest(approval)]);
    setPendingRequests("mcp", [mcpRequest({ ...approval, at: "2026-11-24T11:00:00.000Z" })]);
    expect(notificationState().items[0].at).toBe(approval.at);
    setPendingRequests("chat", [{ ...event("chat:a", approval.at, "request"), source: "chat" }]);
    setPendingRequests("mcp", []);
    expect(notificationState().items.map((item) => item.id)).toEqual(["chat:a"]);
  });

  it("follows the MCP approvals end to end: waiting, answered from the bell, missed on Stop", async () => {
    // The same wiring as useNotificationSources, without React.
    setRequestAnswerer("mcp", (id, answer) => answerApproval(Number(id), answer as "once"));
    const stopEnded = onApprovalEnded((ended, outcome) => {
      const missed = mcpMissed(ended, outcome, "2026-11-24T10:05:00.000Z", 5);
      if (missed) addNotification(missed);
    });
    const ask = () =>
      askDeveloper({ agent: "Codex", kind: "save", title: "Codex wants to save", lines: ["/tmp/x"], answers: ["deny", "once"] });

    const first = ask();
    setPendingRequests("mcp", pendingApprovals().map(mcpRequest));
    answerRequest(`mcp:${pendingApprovals()[0].id}`, "once");
    expect(await first).toBe("once");

    const second = ask();
    stopAgents();
    expect(await second).toBe("stopped");
    stopEnded();
    const missed = sections(notificationState()).missed;
    expect(missed).toHaveLength(1);
    expect(missed[0].lines[0]).toBe("Refused because agents were stopped.");
  });
});

describe("a request nobody answered", () => {
  it("says it timed out, or that agents were stopped, and links to the activity log", () => {
    const timedOut = mcpMissed(approval, "timeout", "2026-11-24T10:05:00.000Z", 5);
    expect(timedOut).toMatchObject({
      id: "missed:mcp:7",
      kind: "missed",
      agent: "Claude Code",
      action: { kind: "open-mcp" },
    });
    expect(timedOut?.lines).toEqual([
      "Nobody answered within 5 minutes, so it was refused and the agent was told.",
      "https://example.com/openapi.yaml",
    ]);
    expect(mcpMissed(approval, "stopped", "x", 5)?.lines[0]).toBe("Refused because agents were stopped.");
  });

  it("isn't added for an answer the developer gave", () => {
    expect(mcpMissed(approval, "deny", "x", 5)).toBeNull();
    expect(mcpMissed(approval, "once", "x", 5)).toBeNull();
  });

  it("is reported when an approval times out", async () => {
    vi.useFakeTimers();
    const ended: string[] = [];
    const stop = onApprovalEnded((_approval, outcome) => ended.push(outcome));
    const outcome = askDeveloper(
      { agent: "Codex", kind: "open", title: "t", lines: [], answers: ["deny", "once"] },
      1000,
    );
    vi.advanceTimersByTime(1000);
    expect(await outcome).toBe("timeout");
    expect(ended).toEqual(["timeout"]);
    stop();
  });
});

describe("the agent chat's permission questions", () => {
  const question = (id: string, state: ChatPermission["state"]): ChatPermission => ({
    id,
    title: "Read package.json",
    state,
    options: [
      { optionId: "a", name: "Allow", kind: "allow_once" },
      { optionId: "aa", name: "Always allow", kind: "allow_always" },
      { optionId: "r", name: "Reject", kind: "reject_once" },
    ],
  });

  it("wait in the bell with the agent's own choices", () => {
    const { waiting, missed } = chatChanges([question("p1", "pending"), question("p0", "answered")], "Codex", [], "t");
    expect(missed).toEqual([]);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ id: "chat:p1", source: "chat", sourceId: "p1", agent: "Codex" });
    expect(waiting[0].answers).toEqual([
      { id: "a", label: "Allow", tone: "primary" },
      { id: "aa", label: "Always allow", tone: "allow" },
      { id: "r", label: "Reject", tone: "deny" },
    ]);
  });

  it("are missed when the chat stops or starts over before they're answered, not when they're answered", () => {
    const before = chatChanges([question("p1", "pending"), question("p2", "pending"), question("p3", "pending")], "Codex", [], "t").waiting;
    const { waiting, missed } = chatChanges([question("p1", "cancelled"), question("p2", "answered")], "Codex", before, "later");
    expect(waiting).toEqual([]);
    // p1 was cancelled, p3 vanished with a new chat; p2 was answered.
    expect(missed.map((item) => item.id)).toEqual(["missed:chat:p1", "missed:chat:p3"]);
    expect(missed[0]).toMatchObject({ kind: "missed", agent: "Codex", at: "later", action: { kind: "open-chat" } });
  });

  it("are read back per source", () => {
    setPendingRequests("chat", chatChanges([question("p1", "pending")], "Codex", [], "t").waiting);
    setPendingRequests("mcp", [mcpRequest(approval)]);
    expect(waitingFrom(notificationState(), "chat").map((item) => item.id)).toEqual(["chat:p1"]);
  });
});

describe("updates", () => {
  it("shows the Studio update a check found, and clears it when a check finds none", () => {
    setStudioUpdate({ version: "0.4.5", currentVersion: "0.4.4" });
    expect(sections(notificationState()).updates[0]).toMatchObject({
      id: "studio-update:0.4.5",
      title: "Studio 0.4.5 is available",
      lines: ["You have 0.4.4."],
      action: { kind: "studio-update" },
    });
    setStudioUpdate(null);
    expect(notificationState().items).toEqual([]);
  });

  it("keeps a dismissed Studio update dismissed for that version only", () => {
    setStudioUpdate({ version: "0.4.5", currentVersion: "0.4.4" });
    dismissNotification("studio-update:0.4.5");
    setStudioUpdate({ version: "0.4.5", currentVersion: "0.4.4" });
    expect(notificationState().items).toEqual([]);
    setStudioUpdate({ version: "0.4.6", currentVersion: "0.4.4" });
    expect(notificationState().items.map((item) => item.id)).toEqual(["studio-update:0.4.6"]);
  });

  it("lists APIs with a newer version, and a later check brings a dismissed one back", () => {
    const mark = { entryId: "e1", title: "Orders", version: "2.1.0", checkedAt: "2026-11-24T08:00:00.000Z" };
    setApiUpdates([mark]);
    expect(sections(notificationState()).updates[0]).toMatchObject({
      title: "Orders has a newer version: 2.1.0",
      action: { kind: "api-update", entryId: "e1" },
    });
    dismissNotification(`api-update:e1:${mark.checkedAt}`);
    setApiUpdates([mark]);
    expect(notificationState().items).toEqual([]);
    setApiUpdates([{ ...mark, checkedAt: "2026-11-24T09:00:00.000Z" }]);
    expect(notificationState().items).toHaveLength(1);
    // Applied, so the library no longer marks it.
    setApiUpdates([]);
    expect(notificationState().items).toEqual([]);
  });
});

describe("finished runs", () => {
  const notice = { collectionId: "c1", runId: "r1", name: "Orders lifecycle", passed: false, text: "failed at step 2 (Pay): 500" };

  it("are added for runs an agent started, with their result and a link to the run", () => {
    expect(runFinishedNotice({ ...notice, startedBy: "Codex" }, "t")).toEqual({
      id: "run:c1:r1",
      kind: "run-finished",
      at: "t",
      title: "Orders lifecycle didn't pass",
      lines: ["failed at step 2 (Pay): 500"],
      agent: "Codex",
      passed: false,
      action: { kind: "open-run", collectionId: "c1", runId: "r1" },
    });
    expect(runFinishedNotice({ ...notice, passed: true, startedBy: "Codex" }, "t")?.title).toBe("Orders lifecycle passed");
  });

  it("aren't added for runs the developer started", () => {
    expect(runFinishedNotice(notice, "t")).toBeNull();
  });
});

describe("the list", () => {
  it("puts each section newest first", () => {
    let state = EMPTY_NOTIFICATIONS;
    state = withEvent(state, event("old", "2026-11-24T08:00:00.000Z"));
    state = withEvent(state, event("new", "2026-11-24T09:00:00.000Z"));
    state = withEvent(state, event("run", "2026-11-24T07:00:00.000Z", "run-finished"));
    expect(sections(state).missed.map((item) => item.id)).toEqual(["new", "old"]);
    expect(sections(state).finished.map((item) => item.id)).toEqual(["run"]);
  });

  it("keeps an event once, and doesn't bring back one that was dismissed", () => {
    addNotification(event("a", "t"));
    addNotification(event("a", "t"));
    expect(notificationState().items).toHaveLength(1);
    dismissNotification("a");
    addNotification(event("a", "t"));
    expect(notificationState().items).toEqual([]);
  });

  it(`keeps the newest ${MAX_KEPT} events, and every waiting request`, () => {
    setPendingRequests("mcp", [mcpRequest(approval)]);
    for (let index = 0; index < MAX_KEPT + 5; index += 1) {
      addNotification(event(`e${index}`, new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString()));
    }
    const { waiting, missed } = sections(notificationState());
    expect(waiting).toHaveLength(1);
    expect(missed).toHaveLength(MAX_KEPT);
    expect(missed.at(-1)?.id).toBe("e5");
  });

  it("tells subscribers only when something changed", () => {
    const heard = vi.fn();
    const stop = subscribeNotifications(heard);
    setApiUpdates([]);
    setPendingRequests("mcp", []);
    dismissAllNotifications();
    expect(heard).not.toHaveBeenCalled();
    addNotification(event("a", "t"));
    expect(heard).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe("asking for attention", () => {
  it("puts the waiting count in the window title, and nothing when none wait", () => {
    expect(attentionTitle("Spec0 Studio", 0)).toBe("Spec0 Studio");
    expect(attentionTitle("Spec0 Studio", 1)).toBe("Spec0 Studio — 1 request waiting");
    expect(attentionTitle("Spec0 Studio", 3)).toBe("Spec0 Studio — 3 requests waiting");
  });

  it("labels the bell with what it holds", () => {
    expect(bellLabel(EMPTY_NOTIFICATIONS)).toBe("Notifications");
    setPendingRequests("mcp", [mcpRequest(approval)]);
    addNotification(event("a", "t"));
    addNotification(event("b", "t"));
    expect(bellLabel(notificationState())).toBe("Notifications: 1 request waiting for you, 2 others");
  });
});
