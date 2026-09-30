/**
 * "Create a mock server": one journey from a spec in the library to a hosted
 * mock you can send requests to.
 *
 * The steps are sign in, choose a team, publish to your organisation, create
 * the mock. Most people need only some of them: someone signed in with one team
 * and an API already on Spec0 needs only the last. So each step is a condition,
 * not a screen in a fixed order. `currentStep` looks at what is already true
 * and shows the first thing that isn't, and the checklist marks the rest done or
 * skipped with a reason.
 *
 * Everything here is pure: the hook (`useMockJourney`) makes the calls and
 * feeds the results back as events, so each skip rule and each error path is
 * tested without React or a network.
 */

import type { SourceKind } from "./library";
import { canPublish } from "./publish";
import {
  planLimitOf,
  Spec0Error,
  type Allowance,
  type Entitlements,
  type TeamSummary,
} from "./spec0";

export type StepId = "signIn" | "team" | "publish" | "mock";

/** What the dialog shows. `blocked` is a limit already reached before starting. */
export type JourneyView = StepId | "done" | "blocked";

export interface JourneyMock {
  mockServerId: string | null;
  url: string;
  /** Null while unknown; the dialog then offers to fetch it or paste it. */
  apiKey: string | null;
}

/** The library entry the journey is for, as it was when the journey started. */
export interface JourneyTarget {
  entryId: string;
  title: string;
  version: string;
  sourceKind: SourceKind;
  /** Set when the API is already on Spec0 (opened from it, or published before). */
  apiId: string | null;
  mock: JourneyMock | null;
}

export type JourneyErrorKind = "session" | "limit" | "breaking" | "network" | "other";

export interface JourneyError {
  kind: JourneyErrorKind;
  message: string;
}

export interface JourneyState {
  target: JourneyTarget;
  signedIn: boolean;
  /** Null until loaded. */
  teams: TeamSummary[] | null;
  /** The team to publish into. Null means the organisation's default team. */
  teamId: string | null;
  teamChosen: boolean;
  /** Undefined until asked; null when the platform didn't say. */
  entitlements: Entitlements | null | undefined;
  apiId: string | null;
  mock: JourneyMock | null;
  /** What is happening right now, in words. */
  busy: string | null;
  error: JourneyError | null;
  /** A neutral note, such as a cancelled sign-in. Not an error. */
  notice: string | null;
}

export type JourneyEvent =
  | { type: "reset"; state: JourneyState }
  | { type: "retryTeams" }
  | { type: "busy"; label: string }
  | { type: "signedIn" }
  | { type: "signedOut" }
  | { type: "signInCancelled" }
  | { type: "teamsLoaded"; teams: TeamSummary[] }
  | { type: "chooseTeam"; teamId: string | null }
  | { type: "entitlements"; value: Entitlements | null }
  | { type: "published"; apiId: string }
  | { type: "mockReady"; mock: JourneyMock }
  | { type: "keyChanged"; apiKey: string | null }
  | { type: "failed"; step: StepId | "done"; error: unknown }
  | { type: "idle" };

export const MOCK_FEATURE = "max_mock_servers";
export const API_FEATURE = "max_internal_apis";

/**
 * Can this entry reach a mock through the journey at all?
 *
 * It needs to be on Spec0 already, or be a spec Studio may publish (opened
 * from a file or a URL). The sample isn't offered: it isn't a real API.
 */
export function journeyAvailable(target: Pick<JourneyTarget, "apiId" | "sourceKind">): boolean {
  return Boolean(target.apiId) || canPublish({ kind: target.sourceKind, ref: "x" });
}

export function initialJourney(target: JourneyTarget, signedIn: boolean): JourneyState {
  return {
    target,
    signedIn,
    teams: null,
    teamId: null,
    teamChosen: false,
    entitlements: undefined,
    apiId: target.apiId,
    mock: target.mock,
    busy: null,
    error: null,
    notice: null,
  };
}

/** The allowance for one feature, if the platform reported it. */
export function allowanceFor(
  entitlements: Entitlements | null | undefined,
  key: string,
): Allowance | null {
  return entitlements?.features.find((row) => row.key === key) ?? null;
}

/** True when nothing more of this kind can be created. `-1` is no limit. */
export function isExhausted(allowance: Allowance | null): boolean {
  if (!allowance) return false;
  if (!allowance.enabled) return true;
  return allowance.limit >= 0 && allowance.used >= allowance.limit;
}

const NOUNS: Record<string, [string, string]> = {
  [MOCK_FEATURE]: ["mock server", "mock servers"],
  [API_FEATURE]: ["API", "APIs"],
};

function noun(key: string, count: number): string {
  const [one, many] = NOUNS[key] ?? ["item", "items"];
  return count === 1 ? one : many;
}

/**
 * The same sentence the server uses when a limit is hit, built from the
 * numbers it reported, so the answer is the same before and after trying.
 */
export function limitMessage(allowance: Allowance): string {
  if (!allowance.enabled || allowance.limit === 0) {
    return `Your organisation can't create ${noun(allowance.key, 2)}.`;
  }
  return `Your organisation has reached its limit of ${allowance.limit} ${noun(allowance.key, allowance.limit)}.`;
}

/**
 * "This uses 1 of your organisation's N mock servers (M in use)." Null
 * when there is nothing to say: no numbers from the platform, or no limit.
 */
export function usageLine(entitlements: Entitlements | null | undefined, key: string): string | null {
  const allowance = allowanceFor(entitlements, key);
  if (!allowance || !allowance.enabled || allowance.limit < 0) return null;
  return `This uses 1 of your organisation's ${allowance.limit} ${noun(key, allowance.limit)} (${allowance.used} in use).`;
}

/** Does the journey still have to publish? */
function needsPublish(state: JourneyState): boolean {
  return !state.apiId;
}

/**
 * A limit already reached for something this journey would create, found
 * before the user goes through any steps. Null when there's none, or when the
 * platform didn't report numbers.
 */
export function upfrontBlock(state: JourneyState): string | null {
  if (state.mock) return null;
  const mockAllowance = allowanceFor(state.entitlements, MOCK_FEATURE);
  if (isExhausted(mockAllowance)) return limitMessage(mockAllowance!);
  if (needsPublish(state)) {
    const apiAllowance = allowanceFor(state.entitlements, API_FEATURE);
    if (isExhausted(apiAllowance)) return limitMessage(apiAllowance!);
  }
  return null;
}

/** The first step that isn't satisfied yet. */
export function currentStep(state: JourneyState): JourneyView {
  if (!state.signedIn) return "signIn";
  if (state.mock) return "done";
  if (upfrontBlock(state)) return "blocked";
  if (needsPublish(state)) {
    if (!journeyAvailable(state.target)) return "blocked";
    if (state.teams === null) return "team";
    if (state.teams.length > 1 && !state.teamChosen) return "team";
    return "publish";
  }
  return "mock";
}

export type StepStatus = "done" | "skipped" | "current" | "todo";

export interface ChecklistItem {
  id: StepId;
  label: string;
  status: StepStatus;
  /** Why a step was skipped, or what it settled on. */
  note: string | null;
}

export const STEP_LABELS: Record<StepId, string> = {
  signIn: "Sign in to Spec0",
  team: "Choose a team",
  publish: "Publish to your organisation",
  mock: "Create the mock",
};

/** The steps as a short checklist, with the ones already satisfied ticked. */
export function checklist(state: JourneyState, orgName?: string | null): ChecklistItem[] {
  const view = currentStep(state);
  const onSpec0Already = Boolean(state.target.apiId);
  const teamName = state.teams?.find((team) => team.id === state.teamId)?.name ?? null;

  const status = (id: StepId, satisfied: boolean, skipped = false): StepStatus => {
    if (skipped) return "skipped";
    if (satisfied) return "done";
    return view === id ? "current" : "todo";
  };

  const teamSkipped =
    onSpec0Already || (state.teams !== null && state.teams.length <= 1);
  const teamNote = onSpec0Already
    ? "Not needed"
    : state.teams === null
      ? null
      : state.teams.length === 0
        ? "Uses the default team"
        : state.teams.length === 1
          ? `Uses ${state.teams[0].name}`
          : state.teamChosen
            ? teamName ?? "Unassigned"
            : null;

  return [
    {
      id: "signIn",
      label: STEP_LABELS.signIn,
      status: status("signIn", state.signedIn),
      note: state.signedIn && orgName ? orgName : null,
    },
    {
      id: "team",
      label: STEP_LABELS.team,
      status: status("team", state.teamChosen || Boolean(state.apiId), teamSkipped),
      note: teamNote,
    },
    {
      id: "publish",
      label: STEP_LABELS.publish,
      status: status("publish", Boolean(state.apiId), onSpec0Already),
      note: onSpec0Already ? "Already on Spec0" : null,
    },
    {
      id: "mock",
      label: STEP_LABELS.mock,
      status: status("mock", Boolean(state.mock), Boolean(state.target.mock)),
      note: state.target.mock ? "Already has one" : null,
    },
  ];
}

/**
 * Turn a failed call into something the journey can act on.
 *
 * - 401: the sign-in has expired; go back to the sign-in step.
 * - 402: a limit; the server's own sentence is shown as is.
 * - 409 while publishing: the spec breaks the version already published under
 *   this version tag; a new version tag is the way through.
 * - no status at all: Spec0 couldn't be reached.
 */
export function classifyError(error: unknown, step: StepId | "done"): JourneyError {
  const limit = planLimitOf(error);
  if (limit) return { kind: "limit", message: limit.detail };

  if (error instanceof Spec0Error) {
    if (error.status === 401) {
      return {
        kind: "session",
        message: "Your Spec0 sign-in has expired or was revoked. Sign in again to continue.",
      };
    }
    if (error.status === 409 && step === "publish") {
      return {
        kind: "breaking",
        message: `${conflictDetail(error.body) ?? "This spec has breaking changes compared with the version already published."} Publish it under a new version to keep both.`,
      };
    }
    if (error.status === 0) {
      return { kind: "network", message: "Couldn't reach Spec0. Check your connection and try again." };
    }
    return { kind: "other", message: error.message };
  }
  return { kind: "other", message: error instanceof Error ? error.message : String(error) };
}

function conflictDetail(body: string): string | null {
  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    const detail = json.detail ?? json.message ?? json.title;
    return typeof detail === "string" && detail.trim() ? detail.trim().replace(/\.?$/, ".") : null;
  } catch {
    return null;
  }
}

export function journeyReducer(state: JourneyState, event: JourneyEvent): JourneyState {
  switch (event.type) {
    case "reset":
      return event.state;
    case "retryTeams":
      return { ...state, teams: null, error: null };
    case "busy":
      return { ...state, busy: event.label, error: null, notice: null };
    case "idle":
      return { ...state, busy: null };
    case "signedIn":
      return { ...state, signedIn: true, busy: null, error: null, notice: null };
    case "signedOut":
      return { ...state, signedIn: false, busy: null, entitlements: undefined, teams: null };
    case "signInCancelled":
      return { ...state, busy: null, error: null, notice: "Sign-in cancelled." };
    case "teamsLoaded": {
      const teams = event.teams;
      // Zero teams: publish to the default one; one team: that one. Neither is a choice.
      if (teams.length <= 1) {
        return { ...state, teams, teamId: teams[0]?.id ?? null, teamChosen: true };
      }
      return { ...state, teams };
    }
    case "chooseTeam":
      return { ...state, teamId: event.teamId, teamChosen: true, error: null };
    case "entitlements":
      return { ...state, entitlements: event.value };
    case "published":
      return { ...state, apiId: event.apiId, busy: null, error: null };
    case "mockReady":
      return { ...state, mock: event.mock, busy: null, error: null };
    case "keyChanged":
      return state.mock ? { ...state, mock: { ...state.mock, apiKey: event.apiKey }, busy: null } : state;
    case "failed": {
      const error = classifyError(event.error, event.step);
      if (error.kind === "session") {
        return { ...state, signedIn: false, busy: null, error, entitlements: undefined, teams: null };
      }
      return { ...state, busy: null, error };
    }
  }
}

/**
 * The operation "Send a test request" sends: a GET that needs no parameters
 * if there is one, since that is the request most likely to succeed as is.
 * Then any GET, then anything.
 */
export function pickTestOperation<T extends { method: string; parameters: Array<{ required: boolean; in: string }> }>(
  operations: T[],
): T | null {
  const gets = operations.filter((op) => op.method.toUpperCase() === "GET");
  return (
    gets.find((op) => !op.parameters.some((param) => param.required && param.in !== "header")) ??
    gets[0] ??
    operations[0] ??
    null
  );
}

/** A "Send a test request" waiting for the screen to catch up. */
export interface PendingTestSend {
  entryId: string;
  opId: string;
  server: string;
  /** The key the send must carry, when Studio has one. */
  apiKey: string | null;
}

/**
 * Is everything the test request depends on on screen yet: the API open, the
 * operation selected, the address bar on the mock and the key stored? Sending
 * any earlier sends whatever was there before, or nothing at all.
 */
export function readyToSend(
  pending: PendingTestSend | null,
  now: {
    route: string;
    entryId: string | null;
    opId: string | null;
    server: string;
    apiKey: string | null;
  },
): boolean {
  if (!pending) return false;
  return (
    now.route === "api" &&
    now.entryId === pending.entryId &&
    now.opId === pending.opId &&
    now.server === pending.server &&
    (pending.apiKey === null || now.apiKey === pending.apiKey)
  );
}

/** Show a key without giving it away: the last four characters. */
export function maskKey(key: string): string {
  return key.length <= 4 ? "••••" : `••••••••${key.slice(-4)}`;
}
