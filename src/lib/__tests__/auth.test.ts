import { describe, expect, it } from "vitest";
import { initialAuth } from "../request";

describe("initialAuth", () => {
  const schemes = [
    { name: "bearer", type: "http", scheme: "bearer" },
    { name: "key", type: "apiKey", in: "header", paramName: "X-Key" },
  ];

  it("restores the scheme used last time", () => {
    expect(initialAuth(schemes, "key")).toEqual({
      schemeName: "key",
      value: "",
      type: "apiKey",
      httpScheme: undefined,
      in: "header",
      paramName: "X-Key",
    });
  });

  it("falls back to the first scheme, or null when there are none", () => {
    expect(initialAuth(schemes, "gone")?.schemeName).toBe("bearer");
    expect(initialAuth(schemes, null)?.schemeName).toBe("bearer");
    expect(initialAuth([], "key")).toBeNull();
  });
});
