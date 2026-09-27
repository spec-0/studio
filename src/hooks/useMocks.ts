import { useCallback, useEffect, useState } from "react";
import { describeMocks, listMocks, type MockRow, type Session } from "../lib/spec0";

/**
 * The signed-in organisation's hosted mocks, for the Mocks tab.
 *
 * Loaded only while the tab is on screen and only with a session: signed out,
 * nothing here makes a request.
 */
export function useMocks(session: Session | null, active: boolean) {
  const [mocks, setMocks] = useState<MockRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setError(null);
    try {
      setMocks(describeMocks(await listMocks(session), session.apiUrl));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [session]);

  // Signing out forgets the list; signing in to another org loads that org's.
  useEffect(() => {
    setMocks(null);
    setError(null);
  }, [session?.orgId, session?.token]);

  useEffect(() => {
    if (active && session && mocks === null && !loading && !error) void refresh();
  }, [active, session, mocks, loading, error, refresh]);

  return { mocks, loading, error, refresh };
}
