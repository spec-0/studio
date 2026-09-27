import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import * as library from "../lib/library";
import type { LibraryEntry } from "../lib/library";
import { resolveMockKey, type Session } from "../lib/spec0";

/**
 * When the address bar points at a mock Studio has no key for, ask Spec0 for
 * the key once and store it. Only if that doesn't work (signed out, an older
 * platform, no permission) does the paste prompt appear.
 *
 * Returns true while the paste prompt should be shown.
 */
export function useMockKey({
  session,
  current,
  targetingMock,
  setEntries,
  setCurrent,
}: {
  session: Session | null;
  current: LibraryEntry | null;
  targetingMock: boolean;
  setEntries: Dispatch<SetStateAction<LibraryEntry[]>>;
  setCurrent: Dispatch<SetStateAction<LibraryEntry | null>>;
}): boolean {
  /** Entry ids whose key lookup is finished without a key. */
  const [missing, setMissing] = useState<Record<string, true>>({});
  const [looking, setLooking] = useState<string | null>(null);

  // Signing in (again) is a reason to try again.
  useEffect(() => setMissing({}), [session?.token]);

  const entryId = current?.id ?? null;
  const needsKey = Boolean(targetingMock && current && !current.mockApiKey);

  useEffect(() => {
    if (!needsKey || !current || !entryId || missing[entryId] || looking === entryId) return;
    if (!session) {
      setMissing((prev) => ({ ...prev, [entryId]: true }));
      return;
    }
    setLooking(entryId);
    void resolveMockKey(session, {
      mockServerId: current.mockServerId ?? null,
      apiId: library.spec0ApiIdOf(current),
    })
      .then(async (found) => {
        if (!found) {
          setMissing((prev) => ({ ...prev, [entryId]: true }));
          return;
        }
        const next = await library.setMock(entryId, {
          mockApiKey: found.apiKey,
          mockServerId: found.mockServerId,
        });
        setEntries(next);
        setCurrent((open) => (open?.id === entryId ? next.find((e) => e.id === entryId) ?? open : open));
      })
      .finally(() => setLooking(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsKey, entryId, session, missing]);

  return needsKey && Boolean(entryId && missing[entryId]);
}
