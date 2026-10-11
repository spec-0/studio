import { useEffect, useRef, useSyncExternalStore } from "react";
import { answerApproval, pendingApprovals, subscribeApprovals } from "../../lib/agentControl";
import type { Answer } from "../../lib/agentPolicy";
import { stopAllAgents } from "../../lib/mcpServer";

const LABELS: Record<Answer, string> = {
  deny: "Don't allow",
  once: "Allow once",
  session: "Allow for this session",
};

/**
 * "Claude Code wants to send requests to localhost:8080": the developer's
 * answer to something an agent asked Studio to do.
 *
 * One approval at a time, oldest first. Everything shown came from the agent
 * and is rendered as text. Focus starts on "Don't allow" and Escape means the
 * same, so a reflexive key press never lets a request through. Clicking
 * outside does nothing: an approval is answered, not dismissed.
 */
export function AgentApprovalDialog() {
  const approvals = useSyncExternalStore(subscribeApprovals, pendingApprovals);
  const approval = approvals[0];
  const denyButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!approval) return;
    denyButton.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") answerApproval(approval.id, "deny");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [approval]);

  if (!approval) return null;
  const more = approvals.length - 1;

  return (
    <div className="scrim">
      <div
        className="modal agent-approval"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="agent-approval-title"
        aria-describedby="agent-approval-detail"
      >
        <div className="modal-head">
          <strong id="agent-approval-title">{approval.title}</strong>
        </div>

        <div className="modal-body" id="agent-approval-detail">
          {approval.lines.map((line, index) => (
            <p key={index} className={index === 0 ? "agent-approval-line mono" : "field-meta"}>
              {line}
            </p>
          ))}
          {approval.kind === "changing" && (
            <p className="field-meta">
              DELETE, PUT and PATCH change or remove data, and this host isn&apos;t on this computer, so Studio asks
              for these separately.
            </p>
          )}
          {approval.answers.includes("session") && approval.sessionNote && (
            <p className="field-meta">“Allow for this session”: {approval.sessionNote}</p>
          )}
          <p className="field-meta">
            Secret values are filled in by Studio and never shown to the agent. Everything it does is listed in the
            MCP tab.{more > 0 ? ` ${more} more waiting.` : ""}
          </p>
        </div>

        <div className="modal-foot">
          <button className="btn ghost" onClick={() => void stopAllAgents()} title="Refuse everything waiting and stop the MCP server">
            Stop agents
          </button>
          <span className="spacer" style={{ flex: 1 }} />
          {approval.answers.map((answer) => (
            <button
              key={answer}
              ref={answer === "deny" ? denyButton : undefined}
              className={answer === "deny" ? "btn" : answer === "once" ? "btn" : "btn primary"}
              onClick={() => answerApproval(approval.id, answer)}
            >
              {LABELS[answer]}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
