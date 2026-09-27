import { describe, expect, it } from "vitest";
import {
  buildTargets,
  environmentFor,
  isTargetingMock,
  mockCredentials,
  sentToMock,
} from "../targets";

describe("buildTargets", () => {
  it("labels servers by host and path, mock and environments after them", () => {
    const targets = buildTargets(
      ["https://api.example.com/v1", "https://api.example.com/"],
      "https://mock.example.com/m/1",
      [{ name: "staging", url: "https://staging.example.com" }],
    );
    expect(targets).toEqual([
      { label: "api.example.com/v1", url: "https://api.example.com/v1", kind: "server" },
      { label: "api.example.com", url: "https://api.example.com/", kind: "server" },
      { label: "Mock server", url: "https://mock.example.com/m/1", kind: "mock" },
      { label: "staging", url: "https://staging.example.com", kind: "env" },
    ]);
  });

  it("shows a templated server verbatim", () => {
    const [target] = buildTargets(["{scheme}://{host}"], null, []);
    expect(target.label).toBe("{scheme}://{host}");
  });

  it("keeps the first of two targets with the same URL", () => {
    const targets = buildTargets(["https://a.example.com"], null, [
      { name: "prod", url: "https://a.example.com" },
    ]);
    expect(targets).toHaveLength(1);
    expect(targets[0].kind).toBe("server");
  });

  it("keeps the platform's environment order", () => {
    const targets = buildTargets([], null, [
      { name: "dev", url: "https://dev" },
      { name: "prod", url: "https://prod" },
      { name: "staging", url: "https://staging" },
    ]);
    expect(targets.map((t) => t.label)).toEqual(["dev", "prod", "staging"]);
  });
});

describe("environmentFor", () => {
  const envs = [
    { name: "staging", url: "https://staging.example.com/" },
    { name: "prod", url: "https://example.com" },
  ];

  it("matches a typed URL, ignoring one trailing slash", () => {
    expect(environmentFor(envs, "https://staging.example.com")?.name).toBe("staging");
    expect(environmentFor(envs, "https://example.com/")?.name).toBe("prod");
  });

  it("returns null for an empty or unknown URL", () => {
    expect(environmentFor(envs, "")).toBeNull();
    expect(environmentFor(envs, "https://other.example.com")).toBeNull();
  });
});

describe("isTargetingMock", () => {
  it("is true only when the resolved URL is the mock", () => {
    expect(isTargetingMock("https://mock/x/", "https://mock/x")).toBe(true);
    expect(isTargetingMock("https://mock/x/y", "https://mock/x")).toBe(false);
    expect(isTargetingMock("", "https://mock/x")).toBe(false);
    expect(isTargetingMock("https://mock/x", null)).toBe(false);
  });
});

describe("sentToMock", () => {
  it("is true for any URL under the mock", () => {
    expect(sentToMock("https://mock/x/pets/1", "https://mock/x/")).toBe(true);
    expect(sentToMock("https://api/pets/1", "https://mock/x")).toBe(false);
    expect(sentToMock("https://mock/x/pets", null)).toBe(false);
  });
});

describe("mockCredentials", () => {
  const session = { apiUrl: "https://api.spec0.example", token: "tok" };

  it("is null without a mock", () => {
    expect(mockCredentials(null, "k", session)).toBeNull();
  });

  it("sends the session token only to the session's own origin", () => {
    expect(mockCredentials("https://api.spec0.example/mock/1", "k", session)).toEqual({
      url: "https://api.spec0.example/mock/1",
      key: "k",
      bearer: "tok",
    });
    expect(mockCredentials("https://evil.example/mock/1", "k", session)?.bearer).toBeUndefined();
  });

  it("sends no token when signed out or when a URL doesn't parse", () => {
    expect(mockCredentials("https://api.spec0.example/m", undefined, null)?.bearer).toBeUndefined();
    expect(
      mockCredentials("not a url", undefined, session)?.bearer,
    ).toBeUndefined();
  });
});
