import { Cloud, CloudOff } from "lucide-react";
import type { Session } from "../lib/spec0";

interface Props {
  session: Session | null;
  /** Opens Settings at Account & Spec0. */
  onClick: () => void;
}

/**
 * Which of the two modes Studio is in, always visible in the top bar.
 *
 * Studio runs either **local**, where everything works with no account and no
 * network, or **signed in**, which adds the organisation's catalog, remote
 * specs and hosted mocks. Before this, the only way to tell was to open a
 * dialog and look, which made a capability difference invisible until it
 * surprised you.
 *
 * This is a status indicator, not a prompt. It never changes size, animates,
 * or asks for anything. It states where you are and is a way into Settings if
 * you want one.
 */
export function ConnectionChip({ session, onClick }: Props) {
  const connected = Boolean(session);
  const label = connected ? `Signed in · ${session!.orgName}` : "Local";
  return (
    <button
      className={`conn-chip${connected ? " on" : ""}`}
      onClick={onClick}
      aria-label={`${label}. Account settings`}
      title={
        connected
          ? `Signed in to Spec0 as ${session!.orgName}: org catalog and hosted mocks available`
          : "Local: everything works without an account. Sign in to Spec0 for your org's catalog and mocks."
      }
    >
      {connected ? <Cloud size={12} /> : <CloudOff size={12} />}
      <span>{label}</span>
    </button>
  );
}
