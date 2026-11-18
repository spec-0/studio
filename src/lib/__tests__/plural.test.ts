import { describe, expect, it } from "vitest";
import { plural } from "../plural";

describe("plural", () => {
  it("pairs a count with the right form of its noun", () => {
    expect(plural(1, "operation")).toBe("1 operation");
    expect(plural(0, "operation")).toBe("0 operations");
    expect(plural(3, "status check")).toBe("3 status checks");
    expect(plural(2, "entry", "entries")).toBe("2 entries");
  });
});
