import { beforeEach, describe, expect, it, vi } from "vitest";

const appFetch = vi.fn();
vi.mock("../request", () => ({ appFetch: (...args: unknown[]) => appFetch(...args) }));

const store = vi.hoisted(() => ({
  awaitOAuthCallback: vi.fn(),
  openInBrowser: vi.fn(async (_url: string) => {}),
}));
vi.mock("../store", () => ({
  awaitOAuthCallback: store.awaitOAuthCallback,
  openInBrowser: store.openInBrowser,
  readCliSession: vi.fn(async () => null),
  readStore: vi.fn(),
  writeStore: vi.fn(),
  STORE: { session: "session.json" },
}));

import {
  createMock,
  getEntitlements,
  getMockApiKey,
  keyNeedsRegenerating,
  newSignInState,
  planLimitMessage,
  planLimitOf,
  planName,
  publishTeamApi,
  readSignInCallback,
  regenerateMockApiKey,
  resolveMockKey,
  SignInCancelled,
  signInViaBrowser,
  Spec0Error,
  type Session,
} from "../spec0";

const session: Session = {
  apiUrl: "https://api.example.com",
  appUrl: "https://app.example.com",
  orgId: "org-1",
  orgName: "Example",
  token: "t",
  source: "manual",
  connectedAt: "2026-01-01T00:00:00Z",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const LIMIT = {
  type: "https://spec0.io/problems/plan-limit-exceeded",
  title: "Limit reached",
  status: 402,
  detail: "Your organisation has reached its limit of 2 mock servers.",
  feature: "max_mock_servers",
  limit: 2,
  used: 2,
};

beforeEach(() => {
  appFetch.mockReset();
  store.awaitOAuthCallback.mockReset();
  store.openInBrowser.mockClear();
});

describe("sign-in callback", () => {
  it("makes a long, random state each time", () => {
    const a = newSignInState();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(newSignInState()).not.toBe(a);
  });

  it("accepts a matching state", () => {
    expect(readSignInCallback({ token: "t", org: "o", org_name: "Acme", state: "s1" }, "s1")).toEqual({
      kind: "ok",
      token: "t",
      orgId: "o",
      orgName: "Acme",
    });
  });

  it("rejects a different state, even with a token", () => {
    const outcome = readSignInCallback({ token: "t", org: "o", state: "other" }, "s1");
    expect(outcome.kind).toBe("error");
  });

  it("accepts a missing state, for sign-in pages that don't send it back yet", () => {
    expect(readSignInCallback({ token: "t", org: "o" }, "s1").kind).toBe("ok");
  });

  it("reads access_denied as cancelled", () => {
    expect(readSignInCallback({ error: "access_denied", state: "s1" }, "s1")).toEqual({ kind: "cancelled" });
  });

  it("shows other errors plainly", () => {
    expect(readSignInCallback({ error: "server_error", error_description: "Try later" }, "s1")).toEqual({
      kind: "error",
      message: "Sign-in failed: Try later",
    });
    expect(readSignInCallback({}, "s1").kind).toBe("error");
  });

  it("asks for a Studio token with a random state, and stores nothing on a mismatch", async () => {
    store.awaitOAuthCallback.mockResolvedValue({ token: "t", org: "o", state: "forged" });
    await expect(signInViaBrowser("https://app.example.com")).rejects.toThrow(/didn't match/);
    const url = new URL(store.openInBrowser.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/cli-auth");
    expect(url.searchParams.get("client")).toBe("studio");
    expect(url.searchParams.get("state")).toMatch(/^[0-9a-f]{64}$/);
    // The listener is told the state too, so the browser tab can say what happened.
    expect(store.awaitOAuthCallback.mock.calls[0][2]).toBe(url.searchParams.get("state"));
  });

  it("returns a session when the state comes back unchanged", async () => {
    store.awaitOAuthCallback.mockImplementation(async (_port: number, _t: number, state: string) => ({
      token: "tok",
      org: "org-9",
      org_name: "Acme",
      state,
    }));
    const next = await signInViaBrowser("https://app.example.com", "https://api.example.com");
    expect(next).toMatchObject({ token: "tok", orgId: "org-9", orgName: "Acme", source: "browser" });
  });

  it("throws SignInCancelled when the user cancels", async () => {
    store.awaitOAuthCallback.mockImplementation(async (_p: number, _t: number, state: string) => ({
      error: "access_denied",
      state,
    }));
    await expect(signInViaBrowser()).rejects.toBeInstanceOf(SignInCancelled);
  });
});

describe("limits reached", () => {
  it("createMock reports a 402 from the numbers Spec0 sent", async () => {
    appFetch.mockResolvedValue(json({ ...LIMIT, plan: "FREE" }, 402));
    const error = await createMock(session, "api-1").catch((e: unknown) => e);
    expect((error as Spec0Error).status).toBe(402);
    expect((error as Spec0Error).message).toBe("You've used 2 of 2 mock servers on the Free plan.");
    expect(planLimitOf(error)).toEqual({
      detail: LIMIT.detail,
      feature: "max_mock_servers",
      limit: 2,
      used: 2,
      plan: "FREE",
      message: "You've used 2 of 2 mock servers on the Free plan.",
    });
  });

  it("publishing reports a 402 the same way", async () => {
    appFetch.mockResolvedValue(json({ ...LIMIT, feature: "max_internal_apis", limit: 5, used: 5, plan: "FREE" }, 402));
    const error = await publishTeamApi(session, {}).catch((e: unknown) => e);
    expect(planLimitOf(error)?.feature).toBe("max_internal_apis");
    expect((error as Spec0Error).message).toBe("You've used 5 of 5 APIs on the Free plan.");
  });

  it("falls back to the server's sentence when the numbers are missing or unknown", async () => {
    appFetch.mockResolvedValue(json({ title: "Limit reached", status: 402, detail: LIMIT.detail }, 402));
    const bare = await createMock(session, "api-1").catch((e: unknown) => e);
    expect((bare as Spec0Error).message).toBe(LIMIT.detail);
    expect(planLimitOf(bare)?.message).toBe(LIMIT.detail);

    appFetch.mockResolvedValue(json({ ...LIMIT, feature: "max_widgets" }, 402));
    const unknown = await createMock(session, "api-1").catch((e: unknown) => e);
    expect(planLimitOf(unknown)?.message).toBe(LIMIT.detail);

    const notJson = planLimitOf(new Spec0Error("Your organisation has reached a limit.", 402, "u", "<html>"));
    expect(notJson).toMatchObject({ feature: null, limit: null, message: "Your organisation has reached a limit." });
  });

  it("words each counted feature, a zero allowance, and a missing plan", () => {
    expect(planLimitMessage({ feature: "max_public_apis", limit: 1, used: 1, plan: "PRO" })).toBe(
      "You've used 1 of 1 public API on the Pro plan.",
    );
    expect(planLimitMessage({ feature: "max_mock_servers", limit: 0, used: 0, plan: "FREE" })).toBe(
      "Your organisation can't create mock servers on the Free plan.",
    );
    expect(planLimitMessage({ feature: "max_mock_servers", limit: 3, used: 3, plan: null })).toBe(
      "You've used 3 of 3 mock servers.",
    );
    expect(planLimitMessage({ feature: "max_mock_servers", limit: -1, used: 3, plan: "FREE" })).toBeNull();
  });

  it("planLimitOf ignores other errors", () => {
    expect(planLimitOf(new Spec0Error("x", 409, "u", "{}"))).toBeNull();
    expect(planLimitOf(new Error("x"))).toBeNull();
  });

  it("createMock reports an unreachable Spec0 with no status", async () => {
    appFetch.mockRejectedValue(new Error("offline"));
    const error = await createMock(session, "api-1").catch((e: unknown) => e);
    expect((error as Spec0Error).status).toBe(0);
  });
});

describe("entitlements", () => {
  it("reads the features, keeping -1 as no limit", async () => {
    appFetch.mockResolvedValue(
      json({ features: [{ key: "max_mock_servers", limit: -1, used: 4, enabled: true }] }),
    );
    expect(await getEntitlements(session)).toEqual({
      plan: null,
      features: [{ key: "max_mock_servers", limit: -1, used: 4, enabled: true }],
    });
    expect(appFetch.mock.calls[0][0]).toBe("https://api.example.com/api/v1/public/orgs/entitlements");
  });

  it("keeps the plan, and names it", async () => {
    appFetch.mockResolvedValue(json({ plan: "FREE", features: [] }));
    const entitlements = await getEntitlements(session);
    expect(entitlements?.plan).toBe("FREE");
    expect(planName(entitlements?.plan)).toBe("Free");
    expect(planName("TEAM_PLUS")).toBe("Team plus");
    expect(planName("Enterprise (trial)")).toBe("Enterprise (trial)");
    expect(planName("")).toBeNull();
    expect(planName(null)).toBeNull();
  });

  it("treats a 404 as unknown", async () => {
    appFetch.mockResolvedValue(new Response("", { status: 404 }));
    expect(await getEntitlements(session)).toBeNull();
  });

  it("lets a 401 through, so the journey can ask to sign in again", async () => {
    appFetch.mockResolvedValue(new Response("", { status: 401 }));
    await expect(getEntitlements(session)).rejects.toMatchObject({ status: 401 });
  });
});

describe("mock keys", () => {
  it("fetches a key", async () => {
    appFetch.mockResolvedValue(json({ mockServerId: "m1", apiKey: "mk_1", apiKeyPreview: "mk_…1" }));
    expect(await getMockApiKey(session, "m1")).toEqual({ mockServerId: "m1", apiKey: "mk_1", apiKeyPreview: "mk_…1" });
    expect(appFetch.mock.calls[0][0]).toBe("https://api.example.com/api/v1/public/mocks/m1/api-key");
  });

  it("returns null on 404, so the paste prompt is the fallback", async () => {
    appFetch.mockResolvedValue(new Response("", { status: 404 }));
    expect(await getMockApiKey(session, "m1")).toBeNull();
  });

  it("throws a 409 as its own case: a key Spec0 can't show again", async () => {
    appFetch.mockResolvedValue(
      json({ title: "Key not recoverable", status: 409, detail: "Regenerate the key to see it." }, 409),
    );
    const error = await getMockApiKey(session, "m1").catch((e: unknown) => e);
    expect(keyNeedsRegenerating(error)).toBe(true);
    expect(keyNeedsRegenerating(new Spec0Error("x", 404, "u", ""))).toBe(false);
    expect(keyNeedsRegenerating(new Error("x"))).toBe(false);
    // The lenient lookup still never throws.
    appFetch.mockResolvedValue(json({ status: 409 }, 409));
    expect(await resolveMockKey(session, { mockServerId: "m1", apiId: null })).toBeNull();
  });

  it("regenerates with a POST", async () => {
    appFetch.mockResolvedValue(json({ mockServerId: "m1", apiKey: "mk_2" }));
    expect((await regenerateMockApiKey(session, "m1")).apiKey).toBe("mk_2");
    expect(appFetch.mock.calls[0][0]).toBe("https://api.example.com/api/v1/public/mocks/m1/api-key/regenerate");
    expect(appFetch.mock.calls[0][1].method).toBe("POST");
  });

  it("resolveMockKey finds the mock id from the API id when only that is known", async () => {
    appFetch
      .mockResolvedValueOnce(json([{ mockServerId: "m7", apiId: "api-1", mockBaseUrl: "/mock/o" }]))
      .mockResolvedValueOnce(json({ mockServerId: "m7", apiKey: "mk_7" }));
    expect(await resolveMockKey(session, { mockServerId: null, apiId: "api-1" })).toMatchObject({
      mockServerId: "m7",
      apiKey: "mk_7",
    });
  });

  it("resolveMockKey never throws: offline or refused is null", async () => {
    appFetch.mockRejectedValue(new Error("offline"));
    expect(await resolveMockKey(session, { mockServerId: "m1", apiId: null })).toBeNull();
    appFetch.mockResolvedValue(new Response("", { status: 404 }));
    expect(await resolveMockKey(session, { mockServerId: "m1", apiId: null })).toBeNull();
    expect(await resolveMockKey(session, { mockServerId: null, apiId: null })).toBeNull();
  });
});
