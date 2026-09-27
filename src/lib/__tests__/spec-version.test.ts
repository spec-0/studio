import { describe, expect, it } from "vitest";
import { parseDocument, parseSpec } from "../spec";

describe("document version checks", () => {
  it("opens Swagger 2.0 by converting it to OpenAPI 3", () => {
    const swagger = JSON.stringify({ swagger: "2.0", info: { title: "Old", version: "1" }, paths: {} });
    expect(parseDocument(swagger).openapi).toBe("3.0.3");
    expect(parseSpec("swagger: '2.0'\ninfo: {title: Old, version: '1'}\npaths: {}\n", "old.yaml").converted?.from).toBe(
      "Swagger 2.0",
    );
  });

  it("still rejects a document with no version field", () => {
    expect(() => parseDocument("{}")).toThrow(/No `openapi` or `swagger` version field/);
  });

  it("accepts OpenAPI 3", () => {
    expect(parseDocument('{"openapi":"3.1.0","info":{"title":"t","version":"1"},"paths":{}}').openapi).toBe("3.1.0");
  });
});
