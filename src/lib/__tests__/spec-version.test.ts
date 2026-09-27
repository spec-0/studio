import { describe, expect, it } from "vitest";
import { SWAGGER2_CONVERT_COMMAND, parseDocument, parseSpec } from "../spec";

describe("document version checks", () => {
  it("tells a Swagger 2.0 user how to convert the spec locally", () => {
    const swagger = JSON.stringify({ swagger: "2.0", info: { title: "Old", version: "1" }, paths: {} });
    expect(() => parseDocument(swagger)).toThrow(SWAGGER2_CONVERT_COMMAND);
    expect(() => parseSpec("swagger: '2.0'\ninfo: {title: Old, version: '1'}\npaths: {}\n", "old.yaml")).toThrow(
      /npx swagger2openapi <file> -o openapi\.json/,
    );
    expect(() => parseDocument(swagger)).toThrow(/support is planned/);
  });

  it("still rejects a document with no version field", () => {
    expect(() => parseDocument("{}")).toThrow(/No `openapi` or `swagger` version field/);
  });

  it("accepts OpenAPI 3", () => {
    expect(parseDocument('{"openapi":"3.1.0","info":{"title":"t","version":"1"},"paths":{}}').openapi).toBe("3.1.0");
  });
});
