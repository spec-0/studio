import { useCallback, useState } from "react";
import { saveSession, type Session } from "../lib/spec0";

/**
 * The spec0 session, if signed in. Optional by design: everything except
 * opening a spec from spec0 works without it.
 */
export function useSession() {
  const [session, setSession] = useState<Session | null>(null);

  const updateSession = useCallback((next: Session | null) => {
    setSession(next);
    void saveSession(next);
  }, []);

  return { session, setSession, updateSession };
}
