import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import * as library from "../lib/library";
import type { LibraryEntry } from "../lib/library";
import type { PublishResult } from "../lib/publish";
import { listTeams, publishTeamApi, type Session, type TeamSummary } from "../lib/spec0";

/**
 * Publishing the open document to spec0.
 *
 * The only write path in the app, so its failures are surfaced rather than
 * swallowed the way the read-side decorations are.
 */
export function usePublish(
  session: Session | null,
  current: LibraryEntry | null,
  setEntries: Dispatch<SetStateAction<LibraryEntry[]>>,
) {
  const [showPublish, setShowPublish] = useState(false);
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [teamsError, setTeamsError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<PublishResult | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);

  /**
   * Open the publish dialog, loading the org's teams as it opens.
   *
   * Signed out this routes to sign-in rather than hiding the action: a button
   * that disappears when you aren't signed in teaches people the feature isn't
   * there, in another form.
   */
  const startPublish = useCallback(() => {
    setPublishResult(null);
    setPublishError(null);
    setTeamsError(null);
    setShowPublish(true);
    if (!session) return;
    void listTeams(session)
      .then(setTeams)
      .catch(() => {
        setTeams([]);
        // Not fatal: publishing without a team is legal and lands the API in
        // the org's "Unassigned APIs" team.
        setTeamsError("Couldn't list teams — you can still publish as unassigned.");
      });
  }, [session]);

  const doPublish = useCallback(
    async (body: unknown) => {
      if (!session || !current) return;
      setPublishing(true);
      setPublishError(null);
      try {
        const result = await publishTeamApi<PublishResult>(session, body);
        setPublishResult(result);
        // The document now exists upstream; remember which API it became, so
        // Studio knows it's published and can offer a mock for it.
        if (result.apiId) {
          await library.touchOpened(current.id);
          setEntries(await library.linkSpec0Api(current.id, result.apiId));
        }
      } catch (error) {
        setPublishError(error instanceof Error ? error.message : String(error));
      } finally {
        setPublishing(false);
      }
    },
    [session, current, setEntries],
  );

  return {
    showPublish,
    setShowPublish,
    teams,
    teamsError,
    publishing,
    publishResult,
    publishError,
    startPublish,
    doPublish,
  };
}
