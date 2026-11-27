import { useEffect, useState } from "react";
import { ExternalLink, LogOut, Search } from "lucide-react";
import { initials } from "../ConnectionChip";
import { getEntitlements, planName, type Session } from "../../lib/spec0";

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
  cli: "your Spec0 CLI session",
  browser: "a browser sign-in",
  manual: "a pasted token",
};

/**
 * The organisation's plan, asked for while this page is open and signed in.
 * Null until known, and when Spec0 doesn't say; the row is then left out.
 */
function useOrgPlan(session: Session | null): string | null {
  const [plan, setPlan] = useState<string | null>(null);
  useEffect(() => {
    setPlan(null);
    if (!session) return;
    let cancelled = false;
    void getEntitlements(session)
      .then((value) => {
        if (!cancelled) setPlan(planName(value?.plan));
      })
      .catch(() => {
        /* No plan shown; nothing else on this page depends on it. */
      });
    return () => {
      cancelled = true;
    };
    // The same org and token need no second request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.orgId, session?.token, session?.apiUrl]);
  return plan;
}

const ADDS: ReadonlyArray<[string, string]> = [
  ["Your organisation's APIs", "Browse the catalog and open any API, private or published."],
  ["Updates from Spec0", "Re-pull a spec when it changes upstream."],
  ["Hosted mocks", "Create mock servers with an address your team can share, and send to them from the address bar."],
];

/** Account & Spec0: whether you're signed in, to which org, and what that adds. */
export function AccountSettings({ session, onSignIn, onBrowseCatalog, onSignOut, onOpenSpec0 }: Props) {
  const plan = useOrgPlan(session);
  if (!session) {
    return (
      <>
        <div className="rows">
          <div className="row-s">
            <div className="l">
              <b>Not signed in</b>
              <span className="meta">
                Everything in Studio works without an account, with no network call to Spec0. Signing in is optional.
              </span>
            </div>
            <div className="c">
              <button className="btn" onClick={onSignIn}>
                Sign in to Spec0…
              </button>
            </div>
          </div>
        </div>
        <div className="section-head">
          <div className="l">
            <h2 className="h2">What signing in adds</h2>
          </div>
        </div>
        <div className="rows">
          {ADDS.map(([title, detail]) => (
            <div className="row-s" key={title}>
              <div className="l">
                <b>{title}</b>
                <span className="meta">{detail}</span>
              </div>
            </div>
          ))}
        </div>
        <p className="meta settings-note">Signing out later returns Studio to local use. Nothing you added is lost.</p>
      </>
    );
  }

  const since = new Date(session.connectedAt);
  return (
    <>
      <div className="rows">
        <div className="row-s">
          <span className="avatar" aria-hidden>
            {initials(session.orgName)}
          </span>
          <div className="l">
            <b>{session.orgName}</b>
            <span className="meta">
              Signed in with {SOURCE_LABEL[session.source] ?? session.source}
              {!Number.isNaN(since.getTime()) ? ` on ${since.toLocaleDateString()}` : ""}
              {plan ? ` · ${plan} plan` : ""}
            </span>
          </div>
          <div className="c">
            <button className="btn danger-outline" onClick={onSignOut}>
              <LogOut size={13} /> Sign out
            </button>
          </div>
        </div>
        <div className="row-s">
          <div className="l">
            <b>Server</b>
          </div>
          <div className="c">
            <code className="mono">{session.apiUrl}</code>
          </div>
        </div>
        <div className="row-s">
          <div className="l">
            <b>Your organisation&apos;s APIs</b>
            <span className="meta">Open any of them; they come with their hosted mock attached.</span>
          </div>
          <div className="c">
            <button className="btn ghost" onClick={onOpenSpec0}>
              Open Spec0 <ExternalLink size={12} />
            </button>
            <button className="btn" onClick={onBrowseCatalog}>
              <Search size={13} /> Browse
            </button>
          </div>
        </div>
      </div>
      <p className="meta settings-note">
        Signing out returns Studio to local use. APIs you added, environments and history stay where they are.
      </p>
    </>
  );
}
