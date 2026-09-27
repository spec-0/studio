import { useCallback, useEffect, useState } from "react";
import { readGitInfo, type GitInfo } from "../lib/git";
import type { LibraryEntry } from "../lib/library";
import { apiIdFromRef, getApiConsumers, type ApiConsumers, type Session } from "../lib/spec0";

/**
 * The two facts about the open document that Studio can't read out of the
 * spec: where the file came from, and who depends on the API. Both are optional
 * and neither gates the view.
 */
export function useDocumentFacts(
  route: string,
  current: LibraryEntry | null,
  session: Session | null,
) {
  const [git, setGit] = useState<GitInfo | null>(null);
  const [consumers, setConsumers] = useState<ApiConsumers | null>(null);

  /**
   * Where the open document came from, when it came from a file in a repo.
   *
   * Read live rather than cached on the entry: a branch you switched twenty
   * minutes ago is worse than no branch at all, and the read is local and cheap.
   * A spec from a URL or from spec0 has no repository behind it and reports
   * nothing, which is the ordinary case rather than a failure.
   */
  useEffect(() => {
    if (route !== "api" || !current) return;
    let live = true;
    void readGitInfo(current.source).then((info) => {
      if (live) setGit(info);
    });
    return () => {
      live = false;
    };
  }, [route, current]);

  /**
   * How many consumers the platform knows about.
   *
   * The only part of this view that needs a session. It is additive by
   * construction: no session, no endpoint, or a token that has stopped working
   * all leave the count absent and everything else on screen untouched.
   */
  useEffect(() => {
    if (route !== "api" || !session || current?.source.kind !== "spec0") return;
    const apiId = apiIdFromRef(current.source.ref);
    if (!apiId) return;
    let live = true;
    void getApiConsumers(session, apiId)
      .then((found) => {
        if (live) setConsumers(found);
      })
      .catch(() => {
        if (live) setConsumers(null);
      });
    return () => {
      live = false;
    };
  }, [route, session, current]);

  /** Forget both facts, when a different document opens. */
  const resetDocumentFacts = useCallback(() => {
    setGit(null);
    setConsumers(null);
  }, []);

  return { git, consumers, resetDocumentFacts };
}
