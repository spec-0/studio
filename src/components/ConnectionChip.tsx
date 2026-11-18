import type { Session } from "../lib/spec0";

interface Props {
  session: Session | null;
  /** Opens Settings at Account & Spec0. */
  onOpenAccount: () => void;
  /** Opens the sign-in choices. */
  onSignIn: () => void;
}

/** Up to two initials from the organisation's name: "Acme" → "A", "Shop Verse" → "SV". */
export function initials(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 1)).toUpperCase();
}

/**
 * Which of Studio's two modes it's in, at the right of the top bar.
 *
 * Signed in, it's a quiet avatar with the organisation's initials: its tooltip
 * names the organisation, and it opens Settings at Account & Spec0. Local, it's
 * a "Sign in" button. Everything works without an account, so it never asks
 * for anything more than that.
 */
export function ConnectionChip({ session, onOpenAccount, onSignIn }: Props) {
  if (!session) {
    return (
      <button
        type="button"
        className="btn ghost sign-in-btn"
        onClick={onSignIn}
        title="Local: everything works without an account. Sign in to Spec0 for your organisation's catalog and hosted mocks."
      >
        Sign in
      </button>
    );
  }
  return (
    <button
      type="button"
      className="avatar"
      onClick={onOpenAccount}
      aria-label={`Signed in to Spec0 as ${session.orgName}. Account settings`}
      title={`Signed in to Spec0 · ${session.orgName}\nOrganisation catalog and hosted mocks available. Account settings`}
    >
      {initials(session.orgName)}
    </button>
  );
}
