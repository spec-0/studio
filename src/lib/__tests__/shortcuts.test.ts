import { describe, expect, it } from "vitest";
import { sendTargetFor } from "../shortcuts";

describe("sendTargetFor", () => {
  it("sends the scratch request on the scratch screen", () => {
    expect(sendTargetFor("scratch")).toBe("scratch");
  });

  it("sends the selected operation when an API is open", () => {
    expect(sendTargetFor("api")).toBe("operation");
  });

  it("sends nothing from the library", () => {
    expect(sendTargetFor("library")).toBeNull();
  });

  it("sends nothing from the history list", () => {
    expect(sendTargetFor("history")).toBeNull();
  });

  it("sends nothing from Mocks, MCP or Settings", () => {
    expect(sendTargetFor("mocks")).toBeNull();
    expect(sendTargetFor("mcp")).toBeNull();
    expect(sendTargetFor("settings")).toBeNull();
  });
});
