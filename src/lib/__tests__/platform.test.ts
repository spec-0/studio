import { describe, expect, it } from "vitest";
import { fileName, shortcut } from "../platform";

describe("shortcut", () => {
  it("uses ⌘ on macOS and Ctrl elsewhere", () => {
    expect(shortcut("P", true)).toBe("⌘P");
    expect(shortcut("P", false)).toBe("Ctrl+P");
  });
});

describe("fileName", () => {
  it("takes the last part of a path with either separator", () => {
    expect(fileName("/Users/me/specs/openapi.yaml")).toBe("openapi.yaml");
    expect(fileName("C:\\Users\\me\\specs\\openapi.yaml")).toBe("openapi.yaml");
    expect(fileName("openapi.yaml")).toBe("openapi.yaml");
  });
});
