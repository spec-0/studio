import { ExternalLink, LogOut, Search } from "lucide-react";
import { ConnectModes } from "../ConnectModes";
import type { Session } from "../../lib/spec0";

interface Props {
  session: Session | null;
  /** Opens the spec0 tab of the Open dialog, where signing in happens. */
  onSignIn: () => void;
  /** The same tab, signed in: the organisation's catalog. */
  onBrowseCatalog: () => void;
  onSignOut: () => void;
  onOpenSpec0: () => void;
}

const SOURCE_LABEL: Record<Session["source"], string> = {
  cli: "your spec0 CLI session",
  browser: "a browser sign-in",
  manual: "a pasted token",
};

/** Account & Spec0: whether you're signed in, to which org, and what that adds. */
export function AccountSettings({ session, onSignIn, onBrowseCatalog, onSignOut, onOpenSpec0 }: Props) {
  if (!session) {
    return (
      <>
        <p className="settings-lead">
          You&apos;re using Studio locally. Everything works without an account. Signing in to
          Spec0 is optional and adds your organisation&apos;s APIs and hosted mocks.
        </p>
        <ConnectModes />
        <button className="btn primary" onClick={onSignIn}>
          Sign in to Spec0…
        </button>
      </>
    );
  }

  const since = new Date(session.connectedAt);
  return (
    <>
      <div className="settings-card">
        <div className="settings-card-row">
          <span className="tag ok">signed in</span>
          <strong>{session.orgName}</strong>
        </div>
        <dl className="settings-facts">
          <dt>Signed in with</dt>
          <dd>{SOURCE_LABEL[session.source] ?? session.source}</dd>
          {!Number.isNaN(since.getTime()) && (
            <>
              <dt>Since</dt>
              <dd>{since.toLocaleString()}</dd>
            </>
          )}
          <dt>Server</dt>
          <dd className="mono">{session.apiUrl}</dd>
        </dl>
        <div className="settings-actions">
          <button className="btn" onClick={onBrowseCatalog}>
            <Search size={13} /> Browse your organisation&apos;s APIs
          </button>
          <button className="btn" onClick={onOpenSpec0}>
            <ExternalLink size={13} /> Open Spec0
          </button>
          <span className="spacer" />
          <button className="btn danger-outline" onClick={onSignOut}>
            <LogOut size={13} /> Sign out
          </button>
        </div>
      </div>
      <p className="field-meta">
        Signing out returns Studio to local use. APIs you added, environments and history stay
        where they are.
      </p>
    </>
  );
}
