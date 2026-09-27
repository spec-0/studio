import { describe, expect, it } from "vitest";
import {
  API_SECTIONS,
  SETTINGS_SECTIONS,
  isApisRoute,
  nextTab,
  routeForTopTab,
  sectionForKey,
  topTabOf,
} from "../navigation";

describe("topTabOf", () => {
  it("puts the library, an open API and the scratch pad under APIs", () => {
    expect(topTabOf("library")).toBe("apis");
    expect(topTabOf("api")).toBe("apis");
    expect(topTabOf("scratch")).toBe("apis");
  });

  it("maps the other tabs to themselves", () => {
    expect(topTabOf("history")).toBe("history");
    expect(topTabOf("mocks")).toBe("mocks");
    expect(topTabOf("mcp")).toBe("mcp");
  });

  it("selects no tab on the Settings page", () => {
    expect(topTabOf("settings")).toBeNull();
  });
});

describe("routeForTopTab", () => {
  it("returns to the open API after visiting another tab", () => {
    expect(routeForTopTab("apis", "history", "api", true)).toBe("api");
    expect(routeForTopTab("apis", "settings", "api", true)).toBe("api");
  });

  it("returns to the scratch pad if that's where you were", () => {
    expect(routeForTopTab("apis", "mocks", "scratch", false)).toBe("scratch");
  });

  it("goes to the list when the API you were on has since closed", () => {
    expect(routeForTopTab("apis", "history", "api", false)).toBe("library");
  });

  it("goes to the list of all APIs when APIs is chosen again", () => {
    expect(routeForTopTab("apis", "api", "api", true)).toBe("library");
    expect(routeForTopTab("apis", "scratch", "scratch", true)).toBe("library");
  });

  it("sends the other tabs straight to their screen", () => {
    expect(routeForTopTab("history", "api", "api", true)).toBe("history");
    expect(routeForTopTab("mocks", "library", "library", false)).toBe("mocks");
    expect(routeForTopTab("mcp", "settings", "api", true)).toBe("mcp");
  });
});

describe("isApisRoute", () => {
  it("is false for screens outside the APIs tab", () => {
    expect(isApisRoute("settings")).toBe(false);
    expect(isApisRoute("history")).toBe(false);
  });
});

describe("sectionForKey", () => {
  it("maps 1 to 4 to the API tabs in order", () => {
    expect(["1", "2", "3", "4"].map(sectionForKey)).toEqual([
      "operations",
      "schemas",
      "graph",
      "document",
    ]);
  });

  it("ignores other keys", () => {
    expect(sectionForKey("5")).toBeNull();
    expect(sectionForKey("a")).toBeNull();
  });

  it("keeps the shortcut keys unique", () => {
    const keys = API_SECTIONS.map((section) => section.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("nextTab", () => {
  const ids = ["a", "b", "c"] as const;

  it("moves with the arrow keys and wraps", () => {
    expect(nextTab(ids, "a", "ArrowRight")).toBe("b");
    expect(nextTab(ids, "c", "ArrowRight")).toBe("a");
    expect(nextTab(ids, "a", "ArrowLeft")).toBe("c");
  });

  it("jumps with Home and End", () => {
    expect(nextTab(ids, "b", "Home")).toBe("a");
    expect(nextTab(ids, "b", "End")).toBe("c");
  });

  it("uses up and down in a vertical list", () => {
    expect(nextTab(ids, "a", "ArrowDown", "vertical")).toBe("b");
    expect(nextTab(ids, "a", "ArrowRight", "vertical")).toBeNull();
  });

  it("ignores other keys", () => {
    expect(nextTab(ids, "a", "Enter")).toBeNull();
  });
});

describe("SETTINGS_SECTIONS", () => {
  it("has a section for MCP, so it can be filled in later", () => {
    expect(SETTINGS_SECTIONS.map((section) => section.id)).toContain("mcp");
  });
});
