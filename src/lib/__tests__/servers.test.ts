import { describe, expect, it } from "vitest";
import { resolveServers } from "../spec";
import { documentUrlOf } from "../library";

describe("resolveServers", () => {
  const doc = "https://petstore3.swagger.io/api/v3/openapi.json";

  it("resolves a path-only server against the document's address", () => {
    expect(resolveServers(["/api/v3"], doc)).toEqual(["https://petstore3.swagger.io/api/v3"]);
  });

  it("resolves a relative path against the document's folder", () => {
    expect(resolveServers(["v2"], "https://example.com/specs/openapi.yaml")).toEqual([
      "https://example.com/specs/v2",
    ]);
  });

  it("leaves absolute servers alone", () => {
    expect(resolveServers(["https://api.example.com/v1"], doc)).toEqual(["https://api.example.com/v1"]);
  });

  it("leaves templated servers alone", () => {
    expect(resolveServers(["{scheme}://{host}/v1"], doc)).toEqual(["{scheme}://{host}/v1"]);
  });

  it("changes nothing without a document address", () => {
    expect(resolveServers(["/api/v3"])).toEqual(["/api/v3"]);
  });
});

describe("documentUrlOf", () => {
  it("only gives an address for specs opened from a URL", () => {
    expect(documentUrlOf({ kind: "url", ref: "https://x.test/o.json" } as never)).toBe("https://x.test/o.json");
    expect(documentUrlOf({ kind: "file", ref: "/tmp/o.json" } as never)).toBeUndefined();
  });
});
