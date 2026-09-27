import { beforeEach, describe, expect, it, vi } from "vitest";

const appFetch = vi.fn();
vi.mock("../request", () => ({ appFetch: (...args: unknown[]) => appFetch(...args) }));

import { listApiEnvironments, refreshMock, Spec0Error, type Session } from "../spec0";

const session: Session = {
  apiUrl: "https://api.example.com/",
  appUrl: "https://app.example.com",
  orgId: "org-1",
  orgName: "Example",
  token: "t",
  source: "manual",
  connectedAt: "2026-01-01T00:00:00Z",
};

beforeEach(() => appFetch.mockReset());

describe("refreshMock", () => {
  it("reports a 404 as a missing mock, and says to re-pull the API", async () => {
    appFetch.mockResolvedValue(new Response("", { status: 404 }));
    const error = await refreshMock(session, "mock-1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Spec0Error);
    expect((error as Spec0Error).status).toBe(404);
    const message = (error as Spec0Error).message;
    expect(message).toMatch(/no longer exists/);
    expect(message).toMatch(/Re-pull the API/);
    // The old wording blamed the platform's version; a 404 no longer means that.
    expect(message).not.toMatch(/release|doesn't support/i);
  });

  it("returns the refresh result on success", async () => {
    appFetch.mockResolvedValue(
      new Response(JSON.stringify({ mockServerId: "mock-1", refreshed: true }), { status: 200 }),
    );
    await expect(refreshMock(session, "mock-1")).resolves.toMatchObject({ refreshed: true });
  });
});

describe("listApiEnvironments", () => {
  it("treats a 404 as no environments", async () => {
    appFetch.mockResolvedValue(new Response("", { status: 404 }));
    await expect(listApiEnvironments(session, "api-1")).resolves.toEqual([]);
  });
});
