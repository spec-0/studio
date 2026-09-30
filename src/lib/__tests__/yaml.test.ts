import { describe, expect, it } from "vitest";
import { parseDocument } from "../spec";
import { parseCollection } from "../collection";
import { loadYaml } from "../yaml";

describe("loadYaml", () => {
  it("resolves merge keys, which specs use to share parameters", () => {
    const doc = loadYaml("base: &base {in: header, required: true}\nparam:\n  <<: *base\n  name: X-Tenant\n");
    expect(doc).toEqual({
      base: { in: "header", required: true },
      param: { in: "header", required: true, name: "X-Tenant" },
    });
  });

  it("keeps an unquoted date as the string written", () => {
    expect(loadYaml("example: 2024-01-01\n")).toEqual({ example: "2024-01-01" });
  });

  it("reads YAML 1.2 scalars", () => {
    expect(loadYaml("a: yes\nb: true\nc: 0o17\nd: 1.0\ne: ~\n")).toEqual({ a: "yes", b: true, c: 15, d: 1, e: null });
  });

  it("treats an empty or comment-only document as no value", () => {
    expect(loadYaml("")).toBeUndefined();
    expect(loadYaml("  \n")).toBeUndefined();
    expect(loadYaml("# nothing here\n")).toBeUndefined();
  });

  it("still throws on invalid YAML", () => {
    expect(() => loadYaml("a: [1, 2\n")).toThrow();
    expect(() => loadYaml("a: 1\n---\nb: 2\n")).toThrow();
  });
});

describe("empty files", () => {
  it("an empty spec reads as the wrong shape, not a parse error", () => {
    expect(() => parseDocument("")).toThrow("The OpenAPI document's root must be an object.");
  });

  it("an empty collection file says it must be a map", () => {
    expect(() => parseCollection("")).toThrow("A collection file must be a YAML map.");
  });
});
