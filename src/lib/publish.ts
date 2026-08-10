/**
 * Publishing a local spec to spec0.
 *
 * Studio pulled from spec0 and never pushed. The gap showed up the moment the
 * document view started reporting that the file on disk has uncommitted changes:
 * Studio could say the local document had moved on, then offer nothing to do.
 *
 * The whole capability rides on one endpoint that already exists — the same one
 * `spec0 push` targets — so what lives here is the judgement, not the transport:
 * what may be published, what to send, and how to report what came back.
 */

import type { ApiSource } from "./library";
import type { GitInfo } from "./git";

/** The platform's own constraint on `name`, copied from the public V1 spec. */
export const API_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface PublishInput {
  /** The document, exactly as held. */
  text: string;
  name: string;
  /** Team UUID or slug. Omitted means the org's "Unassigned APIs" team. */
  team?: string | null;
  version?: string | null;
  git?: GitInfo | null;
}

export interface PublishRequest {
  openapiSpec: string;
  name: string;
  team?: string;
  version?: string;
  gitSha?: string;
  githubBranch?: string;
  specFilePath?: string;
}

export interface PublishResult {
  apiId?: string;
  version?: string;
  created?: boolean;
  versionCreated?: boolean;
  noChanges?: boolean;
  versionUnchanged?: boolean;
  versionUnchangedHint?: string | null;
  apiName?: string;
  teamName?: string;
}

/**
 * Only a spec opened from disk can be published.
 *
 * Studio has no editor, so a spec0-sourced document is byte-identical to what
 * the platform already holds — publishing it back is a no-op carrying a version
 * bump. A URL-sourced one is someone else's document at an address, and the
 * sample is furniture. Offering the button for those would be a claim about
 * what pressing it does that isn't true.
 */
export function canPublish(source: ApiSource | undefined): boolean {
  return source?.kind === "file" && Boolean(source.ref);
}

/** Why the button isn't offered, in the words of the thing that's open. */
export function whyNotPublishable(source: ApiSource | undefined): string | null {
  switch (source?.kind) {
    case "file":
      return source.ref ? null : "This document has no file behind it.";
    case "spec0":
      return "This API already lives in spec0. Studio doesn't edit specs, so there's nothing here to publish back — edit the file and open that instead.";
    case "url":
      return "This spec was fetched from a URL. Save it to a file first — publishing someone else's hosted document isn't the same as publishing yours.";
    case "sample":
      return "The bundled sample isn't a real API.";
    default:
      return "Nothing is open.";
  }
}

/**
 * Turn a title into a name the platform will accept.
 *
 * A suggestion, not a decision — the dialog shows it and it stays editable.
 * Returns an empty string when nothing survives, so the caller shows an empty
 * required field rather than a confident guess like `api`.
 */
export function deriveApiName(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
  return API_NAME_PATTERN.test(slug) ? slug : "";
}

/** Null when the name is fine, otherwise why it isn't — checked before sending. */
export function validateApiName(name: string): string | null {
  if (!name.trim()) return "An API name is required.";
  if (name.length > 63) return "An API name can be at most 63 characters.";
  if (name !== name.toLowerCase()) return "An API name is lower-case.";
  if (!API_NAME_PATTERN.test(name)) {
    return "Letters, digits and dashes only, starting and ending with a letter or digit.";
  }
  return null;
}

/**
 * Build the request body.
 *
 * The one decision worth its own note: **`gitSha` travels only when the working
 * file is clean.** The platform treats a matching sha as "nothing changed" and
 * skips the publish. When the file has uncommitted edits the commit does not
 * describe its contents — that is precisely what the dirty flag is for — so
 * sending it would assert something false and could silently suppress a real
 * publish of work that is only on disk.
 */
export function buildPublishRequest(input: PublishInput): PublishRequest {
  const body: PublishRequest = {
    openapiSpec: input.text,
    name: input.name.trim(),
  };

  const team = input.team?.trim();
  if (team) body.team = team;

  const version = input.version?.trim();
  if (version) body.version = version;

  const git = input.git;
  if (git) {
    if (!git.dirty) body.gitSha = git.sha;
    if (git.branch) body.githubBranch = git.branch;
    if (git.path) body.specFilePath = git.path;
  }
  return body;
}

/**
 * What the platform actually did.
 *
 * "Published" is not one outcome. The two most useful things the response can
 * say are "nothing changed" and "the spec changed but `info.version` didn't",
 * and both are lost if the UI collapses everything into success — the second
 * especially, because it is the one that quietly overwrites a published version
 * in place.
 */
export function describeResult(result: PublishResult): { tone: "ok" | "note"; lines: string[] } {
  const name = result.apiName ?? "the API";
  const where = result.teamName ? ` in ${result.teamName}` : "";
  const version = result.version ? ` ${result.version}` : "";

  if (result.noChanges) {
    return {
      tone: "note",
      lines: [
        `${name} is already up to date${where}.`,
        "The commit this file is on has already been published, so nothing was sent.",
      ],
    };
  }

  const lines: string[] = [];
  lines.push(
    result.created
      ? `Created ${name}${version}${where}.`
      : `Published ${name}${version}${where}.`,
  );

  if (result.versionUnchanged) {
    lines.push(
      result.versionUnchangedHint ??
        "The spec changed but info.version didn't, so this replaced the existing version rather than adding one.",
    );
    return { tone: "note", lines };
  }

  if (result.versionCreated === false) {
    lines.push("No new version snapshot was created.");
    return { tone: "note", lines };
  }

  return { tone: "ok", lines };
}
