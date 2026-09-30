import { describe, expect, it } from "vitest";
import { apiIdFromRef, hasUpdate } from "../spec0";

describe("apiIdFromRef", () => {
  it("extracts the id from a spec0 source ref", () => {
    expect(apiIdFromRef("spec0:3f1a7c62-9b40-4e8d-8a21-5c7f0d2e4b91")).toBe(
      "3f1a7c62-9b40-4e8d-8a21-5c7f0d2e4b91",
    );
  });

  it("returns null for anything else", () => {
    expect(apiIdFromRef("/Users/me/openapi.yaml")).toBeNull();
    expect(apiIdFromRef("https://example.com/openapi.yaml")).toBeNull();
    expect(apiIdFromRef("spec0:")).toBeNull();
  });
});

describe("hasUpdate", () => {
  const upstream = { apiId: "a", version: "1.5.0", updatedAt: "2026-08-02T10:00:00Z" };

  it("detects a changed version tag", () => {
    expect(hasUpdate({ version: "1.4.0", syncedAt: "2026-08-02T11:00:00Z" }, upstream)).toBe(true);
  });

  it("detects a republish under the same version tag", () => {
    // The case a version-only check would miss, and the one a developer most
    // wants to know about: same tag, new content.
    expect(hasUpdate({ version: "1.5.0", syncedAt: "2026-08-01T09:00:00Z" }, upstream)).toBe(true);
  });

  it("reports nothing when we are current", () => {
    expect(hasUpdate({ version: "1.5.0", syncedAt: "2026-08-02T11:00:00Z" }, upstream)).toBe(false);
  });

  it("stays quiet when there is nothing to compare", () => {
    // Claiming an update we can't substantiate is worse than saying nothing.
    expect(hasUpdate({ version: "1.5.0" }, { apiId: "a" })).toBe(false);
    expect(hasUpdate({}, upstream)).toBe(false);
    expect(hasUpdate({ version: "1.4.0" }, undefined)).toBe(false);
  });

  it("ignores an upstream timestamp older than our sync", () => {
    expect(
      hasUpdate({ version: "1.5.0", syncedAt: "2026-08-03T00:00:00Z" }, upstream),
    ).toBe(false);
  });
});
