import { Cloud, CloudOff } from "lucide-react";
import type { Session } from "../lib/spec0";

interface Props {
  session: Session | null;
  onClick: () => void;
}

/**
 * Which of the two modes Studio is in, always visible in the title bar.
 *
 * Studio runs either **local** — everything in the free-tier rule works with no
 * account and no network — or **connected**, which adds the org catalog, remote
 * specs and hosted mocks. Before this, the only way to tell was to open a dialog
 * and look, which made a capability difference invisible until it surprised you.
 *
 * This is a status indicator, not a prompt. The design allows the
 * connection prompt in exactly two places — the spec picker and a one-time note
 * after a validation mismatch — so this never changes size, animates, or asks for
 * anything. It states where you are and is a way in if you want one.
 */
export function ConnectionChip({ session, onClick }: Props) {
  const connected = Boolean(session);
  return (
    <button
      className={`conn-chip${connected ? " on" : ""}`}
      onClick={onClick}
      title={
        connected
          ? `Connected to ${session!.orgName} — org catalog and hosted mocks available`
          : "Local mode — everything works without an account. Connect for your org's catalog and mocks."
      }
    >
      {connected ? <Cloud size={12} /> : <CloudOff size={12} />}
      <span>{connected ? session!.orgName : "Local"}</span>
    </button>
  );
}
