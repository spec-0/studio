import { describe, expect, it } from "vitest";
import {
  checklist,
  classifyError,
  currentStep,
  initialJourney,
  journeyAvailable,
  journeyReducer,
  limitMessage,
  maskKey,
  pickTestOperation,
  upfrontBlock,
  usageLine,
  type JourneyEvent,
  type JourneyState,
  type JourneyTarget,
} from "../mockJourney";
import { deriveApiName, validateApiName } from "../publish";
import { Spec0Error, type Entitlements } from "../spec0";

const FILE: JourneyTarget = {
  entryId: "file_1",
  title: "Orders API",
  version: "1.2.0",
  sourceKind: "file",
  apiId: null,
  mock: null,
};
const ON_SPEC0: JourneyTarget = { ...FILE, entryId: "spec0_1", sourceKind: "spec0", apiId: "api-1" };
const MOCK = { mockServerId: "m1", url: "https://api.example.com/mock/orders", apiKey: "k_123456" };

const TEAMS = [
  { id: "t1", name: "Payments" },
  { id: "t2", name: "Checkout" },
];

function allowances(mocks: [number, number], apis: [number, number] = [-1, 0]): Entitlements {
  return {
    features: [
      { key: "max_mock_servers", limit: mocks[0], used: mocks[1], enabled: true },
      { key: "max_internal_apis", limit: apis[0], used: apis[1], enabled: true },
    ],
  };
}

function run(state: JourneyState, ...events: JourneyEvent[]): JourneyState {
  return events.reduce(journeyReducer, state);
}

const problem = (status: number, body: Record<string, unknown> = {}) =>
  new Spec0Error(`HTTP ${status}`, status, "https://api.example.com/x", JSON.stringify(body));

describe("which step comes first", () => {
  it("starts at sign-in when signed out, whatever else is true", () => {
    expect(currentStep(initialJourney(FILE, false))).toBe("signIn");
    expect(currentStep(initialJourney({ ...ON_SPEC0, mock: MOCK }, false))).toBe("signIn");
  });

  it("waits on the team step while teams load, for an API that needs publishing", () => {
    expect(currentStep(initialJourney(FILE, true))).toBe("team");
  });

  it("skips the team step with no teams, and publishes to the default team", () => {
    const state = run(initialJourney(FILE, true), { type: "teamsLoaded", teams: [] });
    expect(currentStep(state)).toBe("publish");
    expect(state.teamId).toBeNull();
    expect(checklist(state).find((item) => item.id === "team")).toMatchObject({
      status: "skipped",
      note: "Uses the default team",
    });
  });

  it("skips the team step with one team, and uses it", () => {
    const state = run(initialJourney(FILE, true), { type: "teamsLoaded", teams: [TEAMS[0]] });
    expect(currentStep(state)).toBe("publish");
    expect(state.teamId).toBe("t1");
    expect(checklist(state)[1].note).toBe("Uses Payments");
  });

  it("asks for a team when there are several, then publishes", () => {
    let state = run(initialJourney(FILE, true), { type: "teamsLoaded", teams: TEAMS });
    expect(currentStep(state)).toBe("team");
    state = run(state, { type: "chooseTeam", teamId: "t2" });
    expect(currentStep(state)).toBe("publish");
    expect(checklist(state)[1]).toMatchObject({ status: "done", note: "Checkout" });
  });

  it("skips team and publish for an API already on Spec0", () => {
    const state = initialJourney(ON_SPEC0, true);
    expect(currentStep(state)).toBe("mock");
    const items = checklist(state, "Example Org");
    expect(items.map((item) => item.status)).toEqual(["done", "skipped", "skipped", "current"]);
    expect(items[0].note).toBe("Example Org");
    expect(items[2].note).toBe("Already on Spec0");
  });

  it("treats a file published from Studio before as on Spec0", () => {
    expect(currentStep(initialJourney({ ...FILE, apiId: "api-9" }, true))).toBe("mock");
  });

  it("goes straight to done when the API already has a mock", () => {
    const state = initialJourney({ ...ON_SPEC0, mock: MOCK }, true);
    expect(currentStep(state)).toBe("done");
    expect(checklist(state)[3]).toMatchObject({ status: "skipped", note: "Already has one" });
  });

  it("walks the whole way: publish, then mock, then done", () => {
    let state = run(initialJourney(FILE, true), { type: "teamsLoaded", teams: [] });
    state = run(state, { type: "busy", label: "Publishing…" }, { type: "published", apiId: "api-2" });
    expect(currentStep(state)).toBe("mock");
    expect(checklist(state)[2].status).toBe("done");
    state = run(state, { type: "mockReady", mock: MOCK });
    expect(currentStep(state)).toBe("done");
    expect(checklist(state).every((item) => item.status === "done" || item.status === "skipped")).toBe(true);
  });

  it("is offered for files and URLs, not for the sample", () => {
    expect(journeyAvailable({ apiId: null, sourceKind: "url" })).toBe(true);
    expect(journeyAvailable({ apiId: null, sourceKind: "sample" })).toBe(false);
    expect(journeyAvailable({ apiId: null, sourceKind: "file" })).toBe(true);
    expect(journeyAvailable({ apiId: "api-1", sourceKind: "spec0" })).toBe(true);
  });
});

describe("limits", () => {
  it("says up front when no more mocks can be created, before any step", () => {
    const state = run(initialJourney(FILE, true), { type: "entitlements", value: allowances([2, 2]) });
    expect(currentStep(state)).toBe("blocked");
    expect(upfrontBlock(state)).toBe("Your organisation has reached its limit of 2 mock servers.");
  });

  it("says up front when no more APIs can be published, only if publishing is needed", () => {
    const value = allowances([4, 1], [2, 2]);
    expect(currentStep(run(initialJourney(FILE, true), { type: "entitlements", value }))).toBe("blocked");
    expect(upfrontBlock(run(initialJourney(FILE, true), { type: "entitlements", value }))).toBe(
      "Your organisation has reached its limit of 2 APIs.",
    );
    // Already on Spec0: the API limit doesn't matter.
    expect(currentStep(run(initialJourney(ON_SPEC0, true), { type: "entitlements", value }))).toBe("mock");
  });

  it("doesn't block an API that already has a mock", () => {
    const state = run(initialJourney({ ...ON_SPEC0, mock: MOCK }, true), {
      type: "entitlements",
      value: allowances([2, 2]),
    });
    expect(currentStep(state)).toBe("done");
  });

  it("treats -1 as no limit, and a missing endpoint (null) as unknown", () => {
    const unlimited = run(initialJourney(ON_SPEC0, true), { type: "entitlements", value: allowances([-1, 40]) });
    expect(currentStep(unlimited)).toBe("mock");
    expect(usageLine(unlimited.entitlements, "max_mock_servers")).toBeNull();

    const unknown = run(initialJourney(ON_SPEC0, true), { type: "entitlements", value: null });
    expect(currentStep(unknown)).toBe("mock");
    expect(usageLine(unknown.entitlements, "max_mock_servers")).toBeNull();
  });

  it("shows usage with the platform's numbers only", () => {
    expect(usageLine(allowances([2, 1]), "max_mock_servers")).toBe(
      "This uses 1 of your organisation's 2 mock servers (1 in use).",
    );
    expect(usageLine(allowances([4, 0], [1, 0]), "max_internal_apis")).toBe(
      "This uses 1 of your organisation's 1 API (0 in use).",
    );
  });

  it("words a disabled feature without numbers", () => {
    expect(limitMessage({ key: "max_mock_servers", limit: 0, used: 0, enabled: false })).toBe(
      "Your organisation can't create mock servers.",
    );
  });
});

describe("errors", () => {
  const ready = () => run(initialJourney(ON_SPEC0, true), { type: "entitlements", value: null });

  it("401 anywhere sends the journey back to sign-in", () => {
    for (const step of ["team", "publish", "mock", "done"] as const) {
      const state = run(ready(), { type: "failed", step, error: problem(401) });
      expect(currentStep(state)).toBe("signIn");
      expect(state.error?.kind).toBe("session");
      expect(state.entitlements).toBeUndefined();
    }
  });

  it("402 shows the server's sentence as is, and stays on the step", () => {
    const detail = "Your organisation has reached its limit of 2 mock servers.";
    const state = run(ready(), {
      type: "failed",
      step: "mock",
      error: problem(402, { title: "Limit reached", detail, feature: "max_mock_servers", limit: 2, used: 2 }),
    });
    expect(state.error).toEqual({ kind: "limit", message: detail });
    expect(currentStep(state)).toBe("mock");
  });

  it("409 on publish explains breaking changes and suggests a new version", () => {
    const state = run(initialJourney(FILE, true), { type: "teamsLoaded", teams: [] }, {
      type: "failed",
      step: "publish",
      error: problem(409, { detail: "Breaking changes found in 2 operations" }),
    });
    expect(state.error?.kind).toBe("breaking");
    expect(state.error?.message).toBe(
      "Breaking changes found in 2 operations. Publish it under a new version to keep both.",
    );
    expect(currentStep(state)).toBe("publish");
  });

  it("a network failure says Spec0 couldn't be reached", () => {
    const error = classifyError(new Spec0Error("Couldn't reach", 0, "u", ""), "mock");
    expect(error).toEqual({ kind: "network", message: "Couldn't reach Spec0. Check your connection and try again." });
  });

  it("anything else is shown as it was reported", () => {
    expect(classifyError(problem(500), "mock")).toEqual({ kind: "other", message: "HTTP 500" });
    expect(classifyError(new Error("boom"), "publish")).toEqual({ kind: "other", message: "boom" });
  });

  it("a cancelled sign-in is a notice, not an error", () => {
    const state = run(initialJourney(FILE, false), { type: "busy", label: "Waiting…" }, { type: "signInCancelled" });
    expect(state.error).toBeNull();
    expect(state.notice).toBe("Sign-in cancelled.");
    expect(state.busy).toBeNull();
  });

  it("a failed team load can be retried", () => {
    let state = run(initialJourney(FILE, true), { type: "failed", step: "team", error: problem(500) });
    expect(currentStep(state)).toBe("team");
    expect(state.error).not.toBeNull();
    state = run(state, { type: "retryTeams" });
    expect(state.error).toBeNull();
    expect(state.teams).toBeNull();
  });
});

describe("names", () => {
  it("suggests a kebab-case name from the title", () => {
    expect(deriveApiName("Orders API")).toBe("orders-api");
    expect(deriveApiName("Café  Menü v2")).toBe("cafe-menu-v2");
    expect(deriveApiName("!!!")).toBe("");
  });

  it("rejects names the platform won't accept", () => {
    expect(validateApiName("orders-api")).toBeNull();
    expect(validateApiName("")).not.toBeNull();
    expect(validateApiName("Orders")).not.toBeNull();
    expect(validateApiName("orders_api")).not.toBeNull();
    expect(validateApiName("-orders")).not.toBeNull();
  });
});

describe("helpers", () => {
  const op = (id: string, method: string, required = false) => ({
    id,
    method,
    parameters: required ? [{ required: true, in: "path" }] : [{ required: true, in: "header" }],
  });

  it("sends a GET without required parameters first", () => {
    expect(pickTestOperation([op("a", "POST"), op("b", "GET", true), op("c", "GET")])?.id).toBe("c");
    expect(pickTestOperation([op("a", "POST"), op("b", "GET", true)])?.id).toBe("b");
    expect(pickTestOperation([op("a", "POST")])?.id).toBe("a");
    expect(pickTestOperation([])).toBeNull();
  });

  it("masks a key down to its last four characters", () => {
    expect(maskKey("mk_abcdef1234")).toBe("••••••••1234");
    expect(maskKey("abc")).toBe("••••");
  });
});
