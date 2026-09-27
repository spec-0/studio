import { useCallback, useEffect, useState } from "react";
import {
  describeMocks,
  getMockApiKey,
  listMocks,
  regenerateMockApiKey,
  type MockRow,
  type Session,
} from "../lib/spec0";

/** A mock's key as the Mocks tab knows it. */
export type MockKeyState =
  | { status: "loading" }
  | { status: "known"; key: string }
  | { status: "unavailable"; message: string };

/**
 * The signed-in organisation's hosted mocks, for the Mocks tab, and their keys.
 *
 * Loaded only while the tab is on screen and only with a session: signed out,
 * nothing here makes a request. A key is fetched only when someone asks to see
 * or copy it; one Studio already stored is used without a request.
 */
export function useMocks(
  session: Session | null,
  active: boolean,
  {
    storedKey,
    onKeyChanged,
  }: {
    /** A key Studio already holds for this mock, if any. */
    storedKey: (mockServerId: string) => string | null;
    /** Save a fetched or new key wherever that mock is used. */
    onKeyChanged: (mockServerId: string, key: string) => void;
  },
) {
  const [mocks, setMocks] = useState<MockRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keys, setKeys] = useState<Record<string, MockKeyState>>({});

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
    setKeys({});
  }, [session?.orgId, session?.token]);

  useEffect(() => {
    if (active && session && mocks === null && !loading && !error) void refresh();
  }, [active, session, mocks, loading, error, refresh]);

  /** The key, from what Studio stored or from Spec0. Null when neither has it. */
  const loadKey = useCallback(
    async (mockServerId: string): Promise<string | null> => {
      const stored = storedKey(mockServerId);
      if (stored) {
        setKeys((prev) => ({ ...prev, [mockServerId]: { status: "known", key: stored } }));
        return stored;
      }
      if (!session) return null;
      setKeys((prev) => ({ ...prev, [mockServerId]: { status: "loading" } }));
      try {
        const found = await getMockApiKey(session, mockServerId);
        if (!found) {
          setKeys((prev) => ({
            ...prev,
            [mockServerId]: {
              status: "unavailable",
              message: "Spec0 didn't return this key. Copy it from the mock's page in Spec0.",
            },
          }));
          return null;
        }
        onKeyChanged(mockServerId, found.apiKey);
        setKeys((prev) => ({ ...prev, [mockServerId]: { status: "known", key: found.apiKey } }));
        return found.apiKey;
      } catch (caught) {
        setKeys((prev) => ({
          ...prev,
          [mockServerId]: {
            status: "unavailable",
            message: caught instanceof Error ? caught.message : String(caught),
          },
        }));
        return null;
      }
    },
    [session, storedKey, onKeyChanged],
  );

  const regenerateKey = useCallback(
    async (mockServerId: string) => {
      if (!session) return;
      setKeys((prev) => ({ ...prev, [mockServerId]: { status: "loading" } }));
      try {
        const next = await regenerateMockApiKey(session, mockServerId);
        onKeyChanged(mockServerId, next.apiKey);
        setKeys((prev) => ({ ...prev, [mockServerId]: { status: "known", key: next.apiKey } }));
      } catch (caught) {
        setKeys((prev) => ({
          ...prev,
          [mockServerId]: {
            status: "unavailable",
            message: caught instanceof Error ? caught.message : String(caught),
          },
        }));
      }
    },
    [session, onKeyChanged],
  );

  return { mocks, loading, error, refresh, keys, loadKey, regenerateKey };
}
