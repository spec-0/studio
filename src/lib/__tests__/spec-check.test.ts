import { describe, expect, it } from "vitest";
import { parseSpec } from "../spec";
import { noChanges, specChanges, specProblems } from "../specCheck";

const BASE = `openapi: 3.0.3
info: { title: Shop, version: 1.0.0 }
servers: [{ url: https://shop.example.com }]
paths:
  /items/{itemId}:
    get:
      operationId: getItem
      parameters: [{ name: itemId, in: path, required: true, schema: { type: string } }]
      responses: { "200": { description: ok, content: { application/json: { schema: { $ref: "#/components/schemas/Item" } } } } }
components:
  schemas:
    Item: { type: object, properties: { id: { type: string } } }
`;

describe("specProblems", () => {
  it("finds nothing wrong with a sound spec", () => {
    expect(specProblems(BASE, "Shop")).toEqual([]);
  });

  it("says why a document doesn't load", () => {
    const [problem] = specProblems("info: {}", "Shop");
    expect(problem).toMatchObject({ level: "error", where: "document" });
    expect(problem.message).toMatch(/doesn't load/);
  });

  it("finds broken references, undeclared path parameters, duplicate ids and missing responses", () => {
    const broken = `openapi: 3.0.3
info: { title: Shop }
paths:
  /items/{itemId}:
    get:
      operationId: dup
      responses: { "200": { description: ok, content: { application/json: { schema: { $ref: "#/components/schemas/Missing" } } } } }
  /orders/{orderId}:
    get:
      operationId: dup
      parameters:
        - { name: orderId, in: path, required: true, schema: { type: string } }
        - { name: extra, in: path, required: true, schema: { type: string } }
      responses: {}
  /health:
    get: { responses: { "200": { description: ok } } }
`;
    const problems = specProblems(broken, "Shop");
    const messages = problems.map((problem) => `${problem.level}: ${problem.message}`);
    expect(messages).toContain("error: #/components/schemas/Missing doesn't point to anything in the document.");
    expect(messages).toContain("error: The path has {itemId}, but no path parameter called itemId is declared.");
    expect(messages).toContain("error: Path parameter extra is declared, but the path has no {extra}.");
    expect(messages).toContain("error: operationId dup is used 2 times; each must be unique.");
    expect(messages).toContain("error: No responses are declared.");
    expect(messages).toContain("warning: info.version is missing.");
    expect(messages).toContain("warning: No servers are declared, so requests have no default address.");
    expect(messages).toContain("warning: No operationId, so collections refer to it by method and path.");
  });
});

describe("specChanges", () => {
  it("names what changed: version, operations, schemas and servers", () => {
    const before = parseSpec(BASE, "Shop");
    const after = parseSpec(
      BASE.replace("version: 1.0.0", "version: 1.1.0")
        .replace("https://shop.example.com", "https://api.shop.example.com")
        .replace("properties: { id: { type: string } }", "properties: { id: { type: string }, name: { type: string } }")
        .replace("components:", "  /items:\n    get: { operationId: listItems, responses: { \"200\": { description: ok } } }\ncomponents:")
        .concat("    Price: { type: number }\n"),
      "Shop",
    );
    const changes = specChanges(before, after);
    expect(changes).toEqual({
      version: { before: "1.0.0", after: "1.1.0" },
      operationsAdded: ["GET /items"],
      operationsRemoved: [],
      operationsChanged: [],
      schemasAdded: ["Price"],
      schemasRemoved: [],
      schemasChanged: ["Item"],
      serversBefore: ["https://shop.example.com"],
      serversAfter: ["https://api.shop.example.com"],
    });
    expect(noChanges(changes)).toBe(false);
  });

  it("notices a changed operation and says when nothing changed", () => {
    const before = parseSpec(BASE, "Shop");
    expect(noChanges(specChanges(before, parseSpec(BASE, "Shop")))).toBe(true);
    const after = parseSpec(BASE.replace('"200": { description: ok,', '"200": { description: found,'), "Shop");
    expect(specChanges(before, after).operationsChanged).toEqual(["GET /items/{itemId}"]);
  });
});
