import { useEffect, useSyncExternalStore } from "react";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import {
  APPROVAL_TIMEOUT_MS,
  answerApproval,
  onApprovalEnded,
  pendingApprovals,
  subscribeApprovals,
} from "../lib/agentControl";
import type { Answer } from "../lib/agentPolicy";
import type { LibraryEntry } from "../lib/library";
import type { ChatItem } from "../lib/acpClient";
import {
  addNotification,
  attentionTitle,
  chatChanges,
  mcpMissed,
  mcpRequest,
  notificationState,
  runFinishedNotice,
  setApiUpdates,
  setPendingRequests,
  setRequestAnswerer,
  setStudioUpdate,
  subscribeNotifications,
  waitingCount,
  waitingFrom,
  type NotificationState,
} from "../lib/notifications";
import { inTauri } from "../lib/request";
import { runNotices, subscribeRunActivity } from "../lib/runActivity";
import type { UpdatePhase } from "./useUpdater";

/** The window's own title, from tauri.conf.json. */
export const WINDOW_TITLE = "Spec0 Studio";

/** What the bell shows, for the bell. */
export function useNotifications(): NotificationState {
  return useSyncExternalStore(subscribeNotifications, notificationState);
}

/**
 * Feeds the bell from what Studio already knows: the MCP approvals, how each
 * one ended, runs agents started, the Studio update a check found and the
 * library's update marks. It makes no request and starts no check (design
 * rules 1 and 29). The agent chat feeds its own questions, from its panel.
 *
 * While a request waits, it also asks for the developer's attention: the Dock
 * icon bounces on macOS and the taskbar button flashes on Windows, and the
 * window title says how many are waiting.
 */
export function useNotificationSources({ phase, entries }: { phase: UpdatePhase; entries: LibraryEntry[] }): void {
  // MCP approvals: waiting ones, and the ones that ended without an answer.
  useEffect(() => {
    const sync = () => setPendingRequests("mcp", pendingApprovals().map(mcpRequest));
    sync();
    setRequestAnswerer("mcp", (id, answer) => answerApproval(Number(id), answer as Answer));
    const stopApprovals = subscribeApprovals(sync);
    const stopEnded = onApprovalEnded((approval, outcome) => {
      const missed = mcpMissed(approval, outcome, new Date().toISOString(), APPROVAL_TIMEOUT_MS / 60_000);
      if (missed) addNotification(missed);
    });
    return () => {
      stopApprovals();
      stopEnded();
      setRequestAnswerer("mcp", null);
    };
  }, []);

  // Runs an agent started, once they finish. The notice on the page may go
  // away by itself; the bell keeps it for the session.
  useEffect(() => {
    const seen = new Set(runNotices().map((notice) => notice.runId));
    return subscribeRunActivity(() => {
      for (const notice of runNotices()) {
        if (seen.has(notice.runId)) continue;
        seen.add(notice.runId);
        const item = runFinishedNotice(notice, new Date().toISOString());
        if (item) addNotification(item);
      }
    });
  }, []);

  // Studio's own update: only what a check found. A check that says Studio is
  // current clears it; one still running or failing leaves it as it was.
  useEffect(() => {
    if (phase.kind === "available") setStudioUpdate(phase.update);
    else if (phase.kind === "current") setStudioUpdate(null);
  }, [phase]);

  // APIs with a newer version upstream, as the library's last check marked them.
  useEffect(() => {
    setApiUpdates(
      entries
        .filter((entry) => entry.update)
        .map((entry) => ({
          entryId: entry.id,
          title: entry.title,
          version: entry.update?.version,
          checkedAt: entry.update!.checkedAt,
        })),
    );
  }, [entries]);

  // Attention while something waits.
  useEffect(() => {
    let last = waitingCount(notificationState());
    if (last) applyAttention(last, true);
    return subscribeNotifications(() => {
      const now = waitingCount(notificationState());
      if (now === last) return;
      // Ask again for each new request; stop asking once none are left.
      applyAttention(now, now > last);
      last = now;
    });
  }, []);
}

function applyAttention(waiting: number, ask: boolean): void {
  const title = attentionTitle(WINDOW_TITLE, waiting);
  if (!inTauri) {
    document.title = title;
    return;
  }
  // A failure here only means no bounce or title; the bell still shows it.
  const win = getCurrentWindow();
  void win.setTitle(title).catch(() => undefined);
  if (waiting === 0) void win.requestUserAttention(null).catch(() => undefined);
  else if (ask) void win.requestUserAttention(UserAttentionType.Critical).catch(() => undefined);
}

/**
 * The agent chat's permission questions in the bell, answered from there the
 * same as from the chat. Used by the chat panel, which is always mounted.
 */
export function useChatRequests(
  items: readonly ChatItem[],
  agent: string,
  answer: (id: string, optionId: string) => void,
): void {
  useEffect(() => {
    const permissions = items.filter((item): item is Extract<ChatItem, { kind: "permission" }> => item.kind === "permission");
    const { waiting, missed } = chatChanges(
      permissions,
      agent,
      waitingFrom(notificationState(), "chat"),
      new Date().toISOString(),
    );
    setPendingRequests("chat", waiting);
    missed.forEach(addNotification);
  }, [items, agent]);

  useEffect(() => {
    setRequestAnswerer("chat", answer);
    return () => setRequestAnswerer("chat", null);
  }, [answer]);
}
