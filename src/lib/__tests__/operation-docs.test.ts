import { describe, expect, it } from "vitest";
import { parseSpec } from "../spec";

const SPEC = `
openapi: 3.0.3
info: { title: Docs, version: "1" }
paths:
  /orders:
    post:
      operationId: createOrder
      summary: Create an order
      externalDocs:
        url: https://example.com/orders
        description: How orders work
      requestBody:
        description: The order to create.
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/NewOrder" }
      responses:
        "201": { description: The created order }
  /orders/{orderId}:
    get:
      operationId: getOrder
      parameters:
        - { name: orderId, in: path, required: true, schema: { type: string } }
      requestBody:
        $ref: "#/components/requestBodies/Note"
      responses:
        "200": { description: The order }
components:
  requestBodies:
    Note:
      description: A shared body, by reference.
      content:
        text/plain:
          schema: { type: string }
  schemas:
    NewOrder:
      type: object
      properties:
        sku: { type: string }
`;

describe("what the Docs tab reads from an operation", () => {
  const spec = parseSpec(SPEC, "docs.yaml");
  const create = spec.operations.find((op) => op.operationId === "createOrder")!;
  const get = spec.operations.find((op) => op.operationId === "getOrder")!;

  it("keeps the request body's description", () => {
    expect(create.requestBody?.description).toBe("The order to create.");
    expect(create.requestBody?.required).toBe(true);
  });

  it("keeps the description of a request body given by $ref", () => {
    expect(get.requestBody?.description).toBe("A shared body, by reference.");
  });

  it("keeps externalDocs", () => {
    expect(create.externalDocs).toEqual({ url: "https://example.com/orders", description: "How orders work" });
    expect(get.externalDocs).toBeUndefined();
  });

  it("keeps response descriptions", () => {
    expect(create.responses).toEqual([
      expect.objectContaining({ status: "201", description: "The created order" }),
    ]);
  });
});
