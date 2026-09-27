import { describe, expect, it } from "vitest";
import { environmentSyncApiId, type Session } from "../spec0";

const session: Session = {
  apiUrl: "https://api.example.com",
  appUrl: "https://app.example.com",
  orgId: "org-1",
  orgName: "Example",
  token: "t",
  source: "manual",
  connectedAt: "2026-01-01T00:00:00Z",
};

describe("environmentSyncApiId", () => {
  it("loads environments for a spec0 API once signed in", () => {
    expect(environmentSyncApiId(session, { kind: "spec0", ref: "spec0:api-42" })).toBe("api-42");
  });

  it("skips without a session", () => {
    expect(environmentSyncApiId(null, { kind: "spec0", ref: "spec0:api-42" })).toBeNull();
  });

  it("skips APIs that didn't come from spec0", () => {
    expect(environmentSyncApiId(session, { kind: "file", ref: "/tmp/a.yaml" })).toBeNull();
    expect(environmentSyncApiId(session, { kind: "url", ref: "https://x/spec.yaml" })).toBeNull();
  });

  it("skips a malformed spec0 ref", () => {
    expect(environmentSyncApiId(session, { kind: "spec0", ref: "spec0:" })).toBeNull();
  });
});
