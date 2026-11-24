import { useEffect, useId, useRef, useState } from "react";
import { ArrowDownToLine, Bell, CircleAlert, CircleCheck, CircleX, Clock, ShieldQuestion, X } from "lucide-react";
import { useNotifications } from "../hooks/useNotifications";
import { setAgentChatPanelOpen } from "../lib/agentChatPanel";
import { relativeTime } from "../lib/history";
import {
  answerRequest,
  bellLabel,
  dismissAllNotifications,
  dismissNotification,
  sections,
  waitingCount,
  type Notification,
  type NotificationAction,
} from "../lib/notifications";
import { openRun } from "../lib/runActivity";

export interface BellActions {
  /** Show the Updates dialog with the version a check found. */
  onStudioUpdate: () => void;
  /** Pull the newer version of an API into the library, as its Update chip does. */
  onApiUpdate: (entryId: string) => void;
  /** The MCP tab, where the activity log names what each agent asked. */
  onOpenMcp: () => void;
}

const ACTION_LABEL: Record<NotificationAction["kind"], string> = {
  "open-mcp": "View activity",
  "open-chat": "Open chat",
  "studio-update": "Install…",
  "api-update": "Update",
  "open-run": "View run",
};

/**
 * The bell in the top bar: agent requests waiting for an answer, requests
 * nobody answered, updates a check found, and runs agents started.
 *
 * A popover, not a modal: it opens under the bell, takes focus, closes on
 * Escape or a click outside, and gives focus back to the bell. A waiting
 * request is answered here or where it was asked; it can't be dismissed.
 */
export function NotificationBell({ actions }: { actions: BellActions }) {
  const state = useNotifications();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const waiting = waitingCount(state);
  const count = state.items.length;
  const label = bellLabel(state);

  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const outside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    };
    window.addEventListener("mousedown", outside, true);
    return () => window.removeEventListener("mousedown", outside, true);
  }, [open]);

  // Answering or dismissing removes the button that had focus: keep focus in the panel.
  useEffect(() => {
    if (open && (!document.activeElement || document.activeElement === document.body)) panel.current?.focus();
  }, [open, state]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  const act = (action: NotificationAction) => {
    close(false);
    switch (action.kind) {
      case "open-mcp":
        actions.onOpenMcp();
        break;
      case "open-chat":
        setAgentChatPanelOpen(true);
        break;
      case "studio-update":
        actions.onStudioUpdate();
        break;
      case "api-update":
        actions.onApiUpdate(action.entryId);
        break;
      case "open-run":
        openRun(action.collectionId, action.runId);
        break;
    }
  };

  const { waiting: requests, missed, updates, finished } = sections(state);
  const dismissable = count - waiting;

  return (
    <div className="bell">
      <button
        ref={button}
        type="button"
        className={`icon-btn bell-btn${open ? " on" : ""}`}
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={label}
        onClick={() => setOpen((value) => !value)}
      >
        <Bell size={15} aria-hidden />
        {count > 0 && (
          <span className={`bell-badge${waiting ? " waiting" : ""}`} aria-hidden>
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={panel}
          className="bell-panel"
          role="dialog"
          aria-labelledby={headingId}
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close(true);
            }
          }}
        >
          <div className="bell-head">
            <h2 id={headingId}>Notifications</h2>
            <span className="spacer" />
            {dismissable > 0 && (
              <button type="button" className="btn ghost sm" onClick={dismissAllNotifications}>
                Dismiss all
              </button>
            )}
          </div>

          {count === 0 ? (
            <p className="bell-empty">
              Nothing here. Requests from agents, updates and runs agents finish show up here.
            </p>
          ) : (
            <div className="bell-body">
              <Section title="Waiting for you" items={requests} onAct={act} />
              <Section title="Missed" items={missed} onAct={act} />
              <Section title="Updates" items={updates} onAct={act} />
              <Section title="Finished" items={finished} onAct={act} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  items,
  onAct,
}: {
  title: string;
  items: Notification[];
  onAct: (action: NotificationAction) => void;
}) {
  const id = useId();
  if (!items.length) return null;
  return (
    <section className="bell-section" aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      <ul>
        {items.map((item) => (
          <Item key={item.id} item={item} onAct={onAct} />
        ))}
      </ul>
    </section>
  );
}

function ItemIcon({ item }: { item: Notification }) {
  switch (item.kind) {
    case "request":
      return <ShieldQuestion size={14} aria-hidden className="bell-icon waiting" />;
    case "missed":
      return <Clock size={14} aria-hidden className="bell-icon missed" />;
    case "studio-update":
    case "api-update":
      return <ArrowDownToLine size={14} aria-hidden className="bell-icon update" />;
    case "run-finished":
      return item.passed ? (
        <CircleCheck size={14} aria-hidden className="bell-icon passed" />
      ) : (
        <CircleX size={14} aria-hidden className="bell-icon failed" />
      );
    default:
      return <CircleAlert size={14} aria-hidden className="bell-icon" />;
  }
}

function Item({ item, onAct }: { item: Notification; onAct: (action: NotificationAction) => void }) {
  const allows = item.answers?.filter((answer) => answer.tone !== "deny") ?? [];
  const denies = item.answers?.filter((answer) => answer.tone === "deny") ?? [];
  const when = relativeTime(item.at);
  return (
    <li className={`bell-item ${item.kind}`}>
      <ItemIcon item={item} />
      <div className="bell-item-main">
        <div className="bell-item-title">{item.title}</div>
        {item.lines.map((line, index) => (
          <div key={index} className={index === 0 && item.source === "mcp" ? "bell-item-line mono" : "bell-item-line"}>
            {line}
          </div>
        ))}
        <div className="bell-item-meta">
          {[item.agent && (item.kind === "run-finished" ? `Started by ${item.agent}` : item.agent), when]
            .filter(Boolean)
            .join(" · ")}
        </div>
        {item.answers && item.answers.length > 0 && (
          <div className="bell-item-actions">
            {allows.map((answer) => (
              <button
                key={answer.id}
                type="button"
                className={`btn sm${answer.tone === "primary" ? " primary" : ""}`}
                onClick={() => answerRequest(item.id, answer.id)}
              >
                {answer.label}
              </button>
            ))}
            <span className="spacer" />
            {denies.map((answer) => (
              <button key={answer.id} type="button" className="btn sm" onClick={() => answerRequest(item.id, answer.id)}>
                {answer.label}
              </button>
            ))}
          </div>
        )}
        {item.action && (
          <div className="bell-item-actions">
            <button type="button" className="btn sm" onClick={() => onAct(item.action!)}>
              {ACTION_LABEL[item.action.kind]}
            </button>
          </div>
        )}
      </div>
      {item.kind !== "request" && (
        <button
          type="button"
          className="icon-btn tight bell-dismiss"
          aria-label={`Dismiss: ${item.title}`}
          title="Dismiss"
          onClick={() => dismissNotification(item.id)}
        >
          <X size={12} aria-hidden />
        </button>
      )}
    </li>
  );
}
