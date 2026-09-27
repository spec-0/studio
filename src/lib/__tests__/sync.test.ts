import { describe, expect, it } from "vitest";
import { parseSpec } from "../spec";
import {
  describeImpact,
  describeMockRefresh,
  diffSpecs,
  environmentSkew,
  isNoteworthy,
  mockIsBehind,
  updateMarks,
} from "../sync";
import type { HistoryEntry } from "../history";

const spec = (servers: string[], paths: Record<string, unknown>) =>
  parseSpec(
    JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      servers: servers.map((url) => ({ url })),
      paths,
    }),
    "t",
  );

const GET = { get: { responses: { "200": { description: "ok" } } } };

const entry = (operationId: string): HistoryEntry => ({
  id: operationId,
  at: new Date().toISOString(),
  method: "GET",
  path: "/x",
  url: "https://a/x",
  status: 200,
  ms: 1,
  bytes: 1,
  specTitle: "T",
  operationId,
  headers: {},
});

describe("diffSpecs", () => {
  it("reports operations that vanished and appeared", () => {
    const before = spec(["https://a"], { "/a": GET, "/b": GET });
    const after = spec(["https://a"], { "/a": GET, "/c": GET });
    const impact = diffSpecs(before, after, {
      server: "https://a",
      history: [],
      specTitle: "T",
      hasMock: false,
    });
    expect(impact.operationsRemoved).toEqual(["GET /b"]);
    expect(impact.operationsAdded).toEqual(["GET /c"]);
  });

  it("counts history entries that can no longer be replayed", () => {
    const before = spec(["https://a"], { "/a": GET, "/b": GET });
    const after = spec(["https://a"], { "/a": GET });
    const impact = diffSpecs(before, after, {
      server: "https://a",
      history: [entry("GET /b"), entry("GET /b"), entry("GET /a")],
      specTitle: "T",
      hasMock: false,
    });
    expect(impact.historyOrphaned).toBe(2);
  });

  it("ignores history belonging to a different API", () => {
    const before = spec(["https://a"], { "/b": GET });
    const after = spec(["https://a"], {});
    const other = { ...entry("GET /b"), specTitle: "Some other API" };
    const impact = diffSpecs(before, after, {
      server: "https://a",
      history: [other],
      specTitle: "T",
      hasMock: false,
    });
    expect(impact.historyOrphaned).toBe(0);
  });

  it("notices when the base URL stops being a declared server", () => {
    const before = spec(["https://old.example.com"], { "/a": GET });
    const after = spec(["https://new.example.com"], { "/a": GET });
    const impact = diffSpecs(before, after, {
      server: "https://old.example.com",
      history: [],
      specTitle: "T",
      hasMock: false,
    });
    expect(impact.serverNoLongerDeclared).toBe("https://old.example.com");
  });

  it("says nothing about a base URL that was never declared", () => {
    // A URL the user typed was always custom — a sync doesn't change that.
    const before = spec(["https://a"], { "/a": GET });
    const after = spec(["https://b"], { "/a": GET });
    const impact = diffSpecs(before, after, {
      server: "http://localhost:8080",
      history: [],
      specTitle: "T",
      hasMock: false,
    });
    expect(impact.serverNoLongerDeclared).toBeNull();
  });

  it("tolerates a trailing slash on either side", () => {
    const before = spec(["https://a/"], { "/x": GET });
    const after = spec(["https://a"], { "/x": GET });
    const impact = diffSpecs(before, after, {
      server: "https://a",
      history: [],
      specTitle: "T",
      hasMock: false,
    });
    expect(impact.serverNoLongerDeclared).toBeNull();
  });

  it("flags the mock as stale only when there is one", () => {
    const s = spec(["https://a"], { "/a": GET });
    const ctx = { server: "https://a", history: [], specTitle: "T" };
    expect(diffSpecs(s, s, { ...ctx, hasMock: true }).mockNowStale).toBe(true);
    expect(diffSpecs(s, s, { ...ctx, hasMock: false }).mockNowStale).toBe(false);
  });
});

describe("isNoteworthy", () => {
  it("is quiet when a sync only added things", () => {
    const before = spec(["https://a"], { "/a": GET });
    const after = spec(["https://a"], { "/a": GET, "/b": GET });
    const impact = diffSpecs(before, after, {
      server: "https://a",
      history: [],
      specTitle: "T",
      hasMock: false,
    });
    expect(isNoteworthy(impact)).toBe(false);
    expect(describeImpact(impact)).toHaveLength(1);
  });

  it("speaks up when something was removed", () => {
    const before = spec(["https://a"], { "/a": GET, "/b": GET });
    const after = spec(["https://a"], { "/a": GET });
    expect(
      isNoteworthy(
        diffSpecs(before, after, { server: "https://a", history: [], specTitle: "T", hasMock: false }),
      ),
    ).toBe(true);
  });
});

describe("mockIsBehind", () => {
  it("uses the reported version when the platform provides one", () => {
    expect(mockIsBehind({ version: "1.5.0", mockSpecVersion: "1.4.0", mockUrl: "u" })).toBe(true);
    expect(mockIsBehind({ version: "1.5.0", mockSpecVersion: "1.5.0", mockUrl: "u" })).toBe(false);
  });

  it("prefers the reported version over the timestamp heuristic", () => {
    // The heuristic says "something changed since the mock was attached", which is
    // true after any sync — including one that changed nothing relevant. A reported
    // version is a fact and must win.
    expect(
      mockIsBehind({
        version: "1.5.0",
        mockSpecVersion: "1.5.0",
        mockMayBeStale: true,
        mockUrl: "u",
      }),
    ).toBe(false);
  });

  it("falls back to the heuristic when the platform predates the field", () => {
    expect(mockIsBehind({ version: "1.5.0", mockMayBeStale: true, mockUrl: "u" })).toBe(true);
    expect(mockIsBehind({ version: "1.5.0", mockMayBeStale: false, mockUrl: "u" })).toBe(false);
  });

  it("says no when there is nothing to go on", () => {
    // Claiming skew we can't substantiate would undermine the drift verdict this
    // exists to protect.
    expect(mockIsBehind({ version: "1.5.0", mockUrl: "u" })).toBe(false);
  });

  it("says no when there is no mock at all", () => {
    expect(mockIsBehind({ version: "1.5.0", mockSpecVersion: "1.0.0" })).toBe(false);
  });
});

describe("environmentSkew", () => {
  it("reports the mismatch when the environment runs an older version", () => {
    expect(environmentSkew({ name: "staging", currentVersion: "1.4.0" }, "1.5.0")).toEqual({
      name: "staging",
      live: "1.4.0",
      held: "1.5.0",
    });
  });

  it("is silent when they agree", () => {
    expect(environmentSkew({ name: "prod", currentVersion: "2.0.0" }, "2.0.0")).toBeNull();
  });

  it("is silent when nothing has been published to the environment", () => {
    // Unknown is not "different". Warning on it would train people to ignore the
    // warning in the case that actually matters.
    expect(environmentSkew({ name: "staging", currentVersion: null }, "1.5.0")).toBeNull();
    expect(environmentSkew({ name: "staging" }, "1.5.0")).toBeNull();
  });

  it("is silent when the spec we hold declares no version", () => {
    expect(environmentSkew({ name: "staging", currentVersion: "1.4.0" }, undefined)).toBeNull();
  });

  it("is silent when no environment is targeted", () => {
    expect(environmentSkew(null, "1.5.0")).toBeNull();
  });
});

describe("updateMarks", () => {
  const upstream = new Map([
    ["a1", { apiId: "a1", version: "2.0.0" }],
    ["a2", { apiId: "a2", version: "1.0.0" }],
  ]);

  it("marks newer upstream copies and clears the rest of the spec0 entries", () => {
    const marks = updateMarks(
      [
        { id: "e1", source: { kind: "spec0", ref: "spec0:a1" }, version: "1.0.0" },
        { id: "e2", source: { kind: "spec0", ref: "spec0:a2" }, version: "1.0.0" },
        { id: "e3", source: { kind: "file", ref: "/x.yaml" }, version: "1.0.0" },
        { id: "e4", source: { kind: "spec0", ref: "other" }, version: "1.0.0" },
      ],
      upstream,
      "2026-01-01T00:00:00Z",
    );
    expect(marks).toEqual({
      e1: { version: "2.0.0", updatedAt: undefined, checkedAt: "2026-01-01T00:00:00Z" },
      e2: undefined,
    });
    expect("e2" in marks).toBe(true);
    expect("e3" in marks).toBe(false);
    expect("e4" in marks).toBe(false);
  });
});

describe("describeMockRefresh", () => {
  it("says the mock was rebuilt, and what happened to custom variants", () => {
    expect(
      describeMockRefresh({
        refreshed: true,
        specVersion: "1.2.0",
        customVariantsCarriedOver: 2,
        customVariantsDropped: ["a", "b", "c", "d"],
      }),
    ).toEqual([
      "Rebuilt against 1.2.0 — same URL and key",
      "2 custom response variant(s) carried over",
      "4 custom variant(s) dropped — their operation is gone: a, b, c",
    ]);
  });

  it("says when nothing needed rebuilding", () => {
    expect(describeMockRefresh({ refreshed: false })).toEqual(["Already serving the current spec"]);
    expect(describeMockRefresh({ refreshed: true })).toEqual([
      "Rebuilt against the current spec — same URL and key",
    ]);
  });
});
