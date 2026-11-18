import { describe, expect, it } from "vitest";
import { tagLabel } from "../tags";

describe("tagLabel", () => {
  it("turns a framework's tag into words, keeping acronyms", () => {
    expect(tagLabel("api-discovery-rag-controller")).toBe("API discovery RAG");
    expect(tagLabel("user_profile")).toBe("User profile");
    expect(tagLabel("OrderHistoryController")).toBe("Order history");
    expect(tagLabel("mcp-tools")).toBe("MCP tools");
  });

  it("gives a one-word tag a capital, and leaves words alone", () => {
    expect(tagLabel("payments")).toBe("Payments");
    expect(tagLabel("Payments")).toBe("Payments");
    expect(tagLabel("Order history")).toBe("Order history");
  });

  it("keeps a tag that is only \"controller\"", () => {
    expect(tagLabel("controller")).toBe("Controller");
  });
});
