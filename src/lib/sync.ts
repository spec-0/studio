import type { HistoryEntry } from "./history";
import type { AvailableUpdate } from "./library";
import { apiIdFromRef, hasUpdate, type RefreshedMock, type UpstreamState } from "./spec0";
import type { ParsedSpec } from "./spec";

/**
 * What applying an update did to the things you had set up.
 *
 * Replacing a spec silently is the failure mode worth designing against: the
 * operation you were on can vanish, the base URL you were pointed at can stop
 * being a declared server, and history entries can end up referencing paths that
 * no longer exist. None of those break anything, and all of them are confusing
 * if the app doesn't say so.
 */
export interface SyncImpact {
  /** Operation ids (`METHOD /path`) that existed before and don't now. */
  operationsRemoved: string[];
  operationsAdded: string[];
  /** History entries whose operation is gone — they can be read but not replayed. */
  historyOrphaned: number;
  /**
   * The base URL in use, when it was one of the spec's declared servers before
   * and isn't any more. Requests still work — it just became a custom URL.
   */
  serverNoLongerDeclared: string | null;
  /** The mock now serves an older contract than the spec. */
  mockNowStale: boolean;
}

export function diffSpecs(
  before: ParsedSpec,
  after: ParsedSpec,
  context: { server: string; history: HistoryEntry[]; specTitle: string; hasMock: boolean },
): SyncImpact {
  const beforeIds = new Set(before.operations.map((op) => op.id));
  const afterIds = new Set(after.operations.map((op) => op.id));

  const operationsRemoved = [...beforeIds].filter((id) => !afterIds.has(id)).sort();
  const operationsAdded = [...afterIds].filter((id) => !beforeIds.has(id)).sort();

  const removed = new Set(operationsRemoved);
  const historyOrphaned = context.history.filter(
    (entry) => entry.specTitle === context.specTitle && removed.has(entry.operationId),
  ).length;

  const trimmed = context.server.replace(/\/$/, "");
  const wasDeclared = before.servers.some((s) => s.replace(/\/$/, "") === trimmed);
  const stillDeclared = after.servers.some((s) => s.replace(/\/$/, "") === trimmed);

  return {
    operationsRemoved,
    operationsAdded,
    historyOrphaned,
    serverNoLongerDeclared: wasDeclared && !stillDeclared ? context.server : null,
    mockNowStale: context.hasMock,
  };
}

/** True when there's anything worth telling the user about. */
export function isNoteworthy(impact: SyncImpact): boolean {
  return (
    impact.operationsRemoved.length > 0 ||
    impact.historyOrphaned > 0 ||
    impact.serverNoLongerDeclared !== null ||
    impact.mockNowStale
  );
}

/** One-line summaries, most consequential first. */
export function describeImpact(impact: SyncImpact): string[] {
  const lines: string[] = [];
  if (impact.operationsRemoved.length) {
    lines.push(
      `${impact.operationsRemoved.length} operation${impact.operationsRemoved.length > 1 ? "s" : ""} removed: ${impact.operationsRemoved.slice(0, 3).join(", ")}${impact.operationsRemoved.length > 3 ? "…" : ""}`,
    );
  }
  if (impact.historyOrphaned) {
    lines.push(
      `${impact.historyOrphaned} history entr${impact.historyOrphaned > 1 ? "ies" : "y"} can no longer be replayed — their operation is gone`,
    );
  }
  if (impact.serverNoLongerDeclared) {
    lines.push(
      `${impact.serverNoLongerDeclared} is no longer a declared server — it still works, as a custom URL`,
    );
  }
  if (impact.mockNowStale) {
    lines.push(
      "The hosted mock still serves the previous version — responses from it may not match this spec",
    );
  }
  if (impact.operationsAdded.length) {
    lines.push(
      `${impact.operationsAdded.length} new operation${impact.operationsAdded.length > 1 ? "s" : ""}`,
    );
  }
  return lines;
}

/**
 * Is the mock serving an older contract than the spec we hold?
 *
 * Prefers the version the platform reports, because that is a fact. Falls back to
 * "the spec was synced after the mock was attached", which is a heuristic and says
 * only that something changed — it will claim staleness for a sync that changed
 * nothing relevant. When neither is available the answer is no: asserting skew we
 * can't substantiate would undermine the drift verdict it exists to protect.
 */
export function mockIsBehind(entry: {
  version?: string;
  mockSpecVersion?: string;
  mockMayBeStale?: boolean;
  mockUrl?: string;
}): boolean {
  if (!entry.mockUrl) return false;
  if (entry.mockSpecVersion && entry.version) {
    return entry.mockSpecVersion !== entry.version;
  }
  return entry.mockMayBeStale === true;
}

/**
 * Does the targeted environment run a different version than the spec we hold?
 *
 * Only a mismatch counts. An environment with nothing published to it reports no
 * version, and "unknown" is not "different" — claiming skew we can't substantiate
 * would train people to ignore the warning that matters.
 */
export function environmentSkew(
  environment: { name: string; currentVersion?: string | null } | null | undefined,
  specVersion: string | null | undefined,
): { name: string; live: string; held: string } | null {
  const live = environment?.currentVersion;
  if (!environment || !live || !specVersion || live === specVersion) return null;
  return { name: environment.name, live, held: specVersion };
}

/**
 * Mark each spec0-sourced entry that upstream holds a newer copy of.
 *
 * Returns a mark (or `undefined`, which clears an old one) for every entry with a
 * spec0 API id; other entries are left out so their state is untouched. Detection
 * is passive: it marks, it never applies.
 */
export function updateMarks(
  entries: { id: string; source: { kind: string; ref: string }; version?: string; syncedAt?: string }[],
  upstream: Map<string, UpstreamState>,
  checkedAt: string,
): Record<string, AvailableUpdate | undefined> {
  const marks: Record<string, AvailableUpdate | undefined> = {};
  for (const entry of entries) {
    if (entry.source.kind !== "spec0") continue;
    const apiId = apiIdFromRef(entry.source.ref);
    if (!apiId) continue;
    const found = upstream.get(apiId);
    marks[entry.id] = hasUpdate(entry, found)
      ? { version: found?.version, updatedAt: found?.updatedAt, checkedAt }
      : undefined;
  }
  return marks;
}

/** What rebuilding a mock did, one line per fact worth saying. */
export function describeMockRefresh(result: RefreshedMock): string[] {
  const dropped = result.customVariantsDropped ?? [];
  return [
    result.refreshed
      ? `Rebuilt against ${result.specVersion ?? "the current spec"} — same URL and key`
      : "Already serving the current spec",
    ...(result.customVariantsCarriedOver
      ? [`${result.customVariantsCarriedOver} custom response variant(s) carried over`]
      : []),
    ...(dropped.length
      ? [`${dropped.length} custom variant(s) dropped — their operation is gone: ${dropped.slice(0, 3).join(", ")}`]
      : []),
  ];
}
