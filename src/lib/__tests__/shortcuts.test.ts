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
});
