/**
 * Git provenance for a spec that was opened from a file.
 *
 * **This describes the document on disk, never a deployment.** A branch name
 * sitting next to an API is one short step from being read as "this is what
 * production is running", which Studio has no way to know: deployments are
 * facts a platform *reports*, never ones a client infers. So the summary always says what it is about ("the file"), and the
 * dirty flag exists precisely so a commit id is never shown as if it described
 * bytes that have since been edited.
 *
 * Availability is best-effort by design: no repository, no git binary, or a
 * spec that came from a URL or from spec0 all produce `null`, and the caller
 * shows nothing. None of those are errors and none of them block the view.
 */

import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "./request";
import { relativeTime } from "./history";
import type { ApiSource } from "./library";

export interface GitInfo {
  /** Null when HEAD is detached. */
  branch: string | null;
  sha: string;
  subject: string;
  /** ISO-8601. */
  committedAt: string;
  /** The spec file itself differs from HEAD. */
  dirty: boolean;
  root: string;
  /** Path relative to the repository root. */
  path: string;
}

/** Rust returns snake_case; the app speaks camelCase. */
interface RawGitInfo {
  branch: string | null;
  sha: string;
  subject: string;
  committed_at: string;
  dirty: boolean;
  root: string;
  path: string;
}

/**
 * Only a `file:` source can have a repository behind it.
 *
 * A URL or spec0 import has provenance too, but it is the platform's version
 * history: a different fact, already shown elsewhere. Conflating the two
 * would be the "where is this deployed" mistake in another form.
 */
export function canHaveGitInfo(source: ApiSource | undefined): boolean {
  return source?.kind === "file" && Boolean(source.ref);
}

export async function readGitInfo(source: ApiSource | undefined): Promise<GitInfo | null> {
  if (!inTauri || !canHaveGitInfo(source)) return null;
  try {
    const raw = await invoke<RawGitInfo | null>("git_info", { path: source!.ref });
    if (!raw?.sha) return null;
    return {
      branch: raw.branch,
      sha: raw.sha,
      subject: raw.subject,
      committedAt: raw.committed_at,
      dirty: raw.dirty,
      root: raw.root,
      path: raw.path,
    };
  } catch {
    // Provenance is decoration. It never gets to break opening a spec.
    return null;
  }
}

/** Short label for the chip: the branch, or the commit when HEAD is detached. */
export function refLabel(info: GitInfo): string {
  return info.branch ?? `detached at ${info.sha}`;
}

/**
 * The sentence shown on hover.
 *
 * Says "this file" on purpose. See the note at the top of this module.
 */
export function describeGit(info: GitInfo): string {
  const when = relativeTime(info.committedAt);
  const where = info.branch ? `on ${info.branch}` : "with HEAD detached";
  const commit = [info.sha, info.subject].filter(Boolean).join(" · ");
  const base = `This file is in ${info.root} ${where}. Last commit ${commit}${
    when ? ` (${when})` : ""
  }.`;
  return info.dirty
    ? `${base} The file has uncommitted changes, so what you are reading is not that commit.`
    : base;
}
