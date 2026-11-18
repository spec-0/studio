import type { ReactNode } from "react";

interface Props {
  icon: ReactNode;
  title: ReactNode;
  /** One sentence. */
  body?: ReactNode;
  /** A button or two. */
  action?: ReactNode;
  className?: string;
}

/** The one empty state: an icon tile, a title, a sentence, and maybe a button. */
export function EmptyState({ icon, title, body, action, className }: Props) {
  return (
    <div className={`empty-state${className ? ` ${className}` : ""}`}>
      <div className="empty-state-box">
        <div className="empty-state-icon" aria-hidden>
          {icon}
        </div>
        <div className="empty-state-title">{title}</div>
        {body && <div className="empty-state-body">{body}</div>}
        {action && <div className="empty-state-actions">{action}</div>}
      </div>
    </div>
  );
}
