/**
 * Local mocks: how a request is matched to an operation and what comes back.
 *
 * The socket and the Host/Origin/CORS checks are Rust's, tested in
 * `src-tauri/src/local_mock.rs`. Everything that depends on the spec is here.
 */

import { describe, expect, it } from "vitest";
import { exampleBody, exampleFor, mediaExample } from "../example";
import {
  answerMockRequest,
  candidatePaths,
  chooseMediaType,
  chooseResponse,
  matchOperation,
  matchPath,
  OPERATION_HEADER,
  requestedStatus,
  warningsHeader,
  WARNINGS_HEADER,
  type MockRequest,
} from "../localMock";
import { SAMPLE_NAME, SAMPLE_SPEC } from "../sample";
import { parseSpec, type Json } from "../spec";
import { withLocalMock } from "../targets";
import { localMockLabel, localMockUrl } from "../localMockServer";

const sample = parseSpec(SAMPLE_SPEC, SAMPLE_NAME);

function req(method: string, target: string, extra: Partial<MockRequest> = {}): MockRequest {
  const [path, query = ""] = target.split("?");
  return { method, path, query, headers: {}, body: "", ...extra };
}

const header = (response: { headers: Array<[string, string]> }, name: string) =>
  response.headers.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];

const spec = (paths: Json, extra: Json = {}) =>
  parseSpec(JSON.stringify({ openapi: "3.0.3", info: { title: "T", version: "1" }, paths, ...extra }), "t");

describe("matchPath", () => {
  it("matches literal and templated segments and decodes parameters", () => {
    expect(matchPath("/orders", "/orders")).toEqual({});
    expect(matchPath("/orders/{orderId}", "/orders/a%20b")).toEqual({ orderId: "a b" });
    expect(matchPath("/files/{name}.json", "/files/report.json")).toEqual({ name: "report" });
    expect(matchPath("/a/{x}/b/{y}", "/a/1/b/2")).toEqual({ x: "1", y: "2" });
  });

  it("forgives one trailing slash and nothing else", () => {
    expect(matchPath("/orders", "/orders/")).toEqual({});
    expect(matchPath("/orders/{id}", "/orders/")).toBeNull();
    expect(matchPath("/orders/{id}", "/orders/1/extra")).toBeNull();
    expect(matchPath("/orders", "/order")).toBeNull();
    expect(matchPath("/files/{name}.json", "/files/report.xml")).toBeNull();
  });
});

describe("matchOperation", () => {
  it("finds the operation, with and without the server's base path", () => {
    const direct = matchOperation(sample, "GET", "/orders/42");
    const based = matchOperation(sample, "GET", "/v1/orders/42");
    for (const match of [direct, based]) {
      expect(match.kind).toBe("found");
      if (match.kind === "found") {
        expect(match.op.id).toBe("GET /orders/{orderId}");
        expect(match.params).toEqual({ orderId: "42" });
      }
    }
    expect(candidatePaths(["https://api.example.com/v1"], "/v1/orders")).toEqual(["/v1/orders", "/orders"]);
    expect(candidatePaths(["{scheme}://host/v1"], "/v1/orders")).toEqual(["/v1/orders"]);
  });

  it("prefers the more specific template", () => {
    const s = spec({
      "/orders/{id}": { get: { responses: { "200": { description: "one" } } } },
      "/orders/latest": { get: { responses: { "200": { description: "latest" } } } },
    });
    const match = matchOperation(s, "GET", "/orders/latest");
    expect(match.kind === "found" && match.op.path).toBe("/orders/latest");
  });

  it("answers HEAD from GET, and reports the methods a path takes", () => {
    const head = matchOperation(sample, "HEAD", "/orders");
    expect(head.kind === "found" && head.head).toBe(true);
    expect(matchOperation(sample, "DELETE", "/orders")).toEqual({
      kind: "method",
      allowed: ["GET", "HEAD", "POST"],
    });
  });

  it("lists the closest operations for an unknown path", () => {
    const match = matchOperation(sample, "GET", "/ordrs");
    expect(match.kind).toBe("none");
    if (match.kind === "none") {
      expect(match.closest).toHaveLength(3);
      expect(match.closest[0]).toMatch(/ \/orders$/);
    }
  });
});

describe("choosing the response", () => {
  const doc: Json = {};
  const responses = {
    "404": { description: "missing" },
    "201": { description: "created" },
    "200": { description: "ok" },
    "4XX": { description: "client error" },
    default: { description: "anything else" },
  };

  it("uses the lowest 2xx the spec declares", () => {
    expect(chooseResponse(doc, responses, null)).toMatchObject({ status: 200, definition: { description: "ok" } });
    expect(chooseResponse(doc, { "404": {}, "201": { description: "created" } }, null).status).toBe(201);
    expect(chooseResponse(doc, { "2XX": { description: "r" } }, null).status).toBe(200);
    expect(chooseResponse(doc, { default: { description: "d" } }, null).status).toBe(200);
    expect(chooseResponse(doc, { "302": { description: "moved" } }, null).status).toBe(302);
    expect(chooseResponse(doc, {}, null).status).toBe(204);
  });

  it("honours a requested status: exact, then a range, then default, then undeclared", () => {
    expect(chooseResponse(doc, responses, 404).definition?.description).toBe("missing");
    expect(chooseResponse(doc, responses, 409)).toMatchObject({ status: 409, definition: { description: "client error" } });
    expect(chooseResponse(doc, responses, 503)).toMatchObject({ status: 503, definition: { description: "anything else" } });
    expect(chooseResponse(doc, { "200": { description: "ok" } }, 500)).toEqual({
      status: 500,
      definition: undefined,
      undeclared: true,
    });
  });

  it("reads the requested status from Prefer, X-Mock-Status or ?__status", () => {
    const none = new URLSearchParams();
    expect(requestedStatus({ prefer: "code=404" }, none)).toBe(404);
    expect(requestedStatus({ prefer: "return=minimal, code=422" }, none)).toBe(422);
    expect(requestedStatus({ "x-mock-status": "500" }, none)).toBe(500);
    expect(requestedStatus({}, new URLSearchParams("__status=401"))).toBe(401);
    expect(requestedStatus({ "x-mock-status": "abc" }, none)).toBeNull();
    expect(requestedStatus({ "x-mock-status": "999" }, none)).toBeNull();
    expect(requestedStatus({}, none)).toBeNull();
  });

  it("picks the media type Accept asks for, else JSON, else the first", () => {
    const content = { "application/xml": {}, "application/json": {}, "text/csv": {} };
    expect(chooseMediaType(content, undefined)).toBe("application/json");
    expect(chooseMediaType(content, "text/csv")).toBe("text/csv");
    expect(chooseMediaType(content, "text/*;q=0.9")).toBe("text/csv");
    expect(chooseMediaType(content, "image/png")).toBe("application/json");
    expect(chooseMediaType({ "text/plain": {} }, "*/*")).toBe("text/plain");
    expect(chooseMediaType(undefined, "application/json")).toBeUndefined();
  });
});

describe("body generation priority", () => {
  const doc: Json = {
    components: {
      examples: { Paid: { value: { status: "paid", from: "components" } } },
      schemas: {
        Named: { type: "object", properties: { status: { type: "string", enum: ["pending", "paid"] } } },
      },
    },
  };

  it("media type example, then its examples, then the schema", () => {
    const schema = { type: "object", example: { from: "schema" } };
    expect(mediaExample(doc, { example: { from: "media" }, schema })).toEqual({ from: "media" });
    expect(mediaExample(doc, { examples: { a: { $ref: "#/components/examples/Paid" } }, schema })).toEqual({
      status: "paid",
      from: "components",
    });
    expect(mediaExample(doc, { schema })).toEqual({ from: "schema" });
    expect(mediaExample(doc, {})).toBeUndefined();
  });

  it("schema example, then examples, then property examples", () => {
    expect(exampleFor(doc, { type: "string", example: "a", examples: ["b"] })).toBe("a");
    expect(exampleFor(doc, { type: "string", examples: ["b", "c"] })).toBe("b");
    expect(
      exampleFor(doc, {
        type: "object",
        properties: { name: { type: "string", example: "Grace" }, age: { type: "integer", example: 36 } },
      }),
    ).toEqual({ name: "Grace", age: 36 });
  });

  it("default, then const, then the first enum value", () => {
    expect(exampleFor(doc, { type: "string", default: "d", const: "c", enum: ["e"] })).toBe("d");
    expect(exampleFor(doc, { type: "string", const: "c", enum: ["e"] })).toBe("c");
    expect(exampleFor(doc, { type: "string", enum: ["e", "f"] })).toBe("e");
  });

  it("then a value for the format, then the name, then the type", () => {
    expect(exampleFor(doc, { type: "string", format: "uuid" }, "x")).toMatch(/^[0-9a-f-]{36}$/);
    expect(exampleFor(doc, { type: "string", format: "date-time" }, "x")).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(exampleFor(doc, { type: "string" }, "email")).toBe("ada@example.com");
    expect(exampleFor(doc, { type: "string" }, "x")).toBe("string");
    expect(exampleFor(doc, { type: "integer" }, "x")).toBe(1);
    expect(exampleFor(doc, { type: "boolean" }, "x")).toBe(true);
  });

  it("leaves out readOnly in requests and writeOnly in responses", () => {
    const schema = {
      type: "object",
      properties: {
        id: { type: "string", readOnly: true, example: "o_1" },
        password: { type: "string", writeOnly: true, example: "secret" },
      },
    };
    expect(exampleFor(doc, schema, "body", "request")).toEqual({ password: "secret" });
    expect(exampleFor(doc, schema, "body", "response")).toEqual({ id: "o_1" });
  });

  it("the request editor uses the media type's example too", () => {
    const media = { example: { note: "from media" }, schema: { type: "object", properties: { note: { type: "string" } } } };
    expect(JSON.parse(exampleBody(doc, media.schema, media))).toEqual({ note: "from media" });
    expect(exampleBody(doc, undefined)).toBe("");
  });
});

describe("answerMockRequest", () => {
  it("answers a 2xx built from the spec, with its content type", () => {
    const response = answerMockRequest(sample, req("GET", "/v1/orders/3f1a7c62-9b40-4e8d-8a21-5c7f0d2e4b91"));
    expect(response.status).toBe(200);
    expect(header(response, "content-type")).toBe("application/json");
    expect(header(response, OPERATION_HEADER)).toBe("GET /orders/{orderId}");
    expect(header(response, WARNINGS_HEADER)).toBeUndefined();
    const body = JSON.parse(response.body);
    expect(body.status).toBe("pending");
    expect(body.total).toEqual({ amount: 1999, currency: "USD" });
  });

  it("uses the declared example, and a named one when asked", () => {
    const s = spec({
      "/pets": {
        get: {
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: { type: "array", items: { type: "object" } },
                  examples: { one: { value: [{ name: "Rex" }] }, two: { value: [{ name: "Tom" }, { name: "Ada" }] } },
                },
              },
            },
          },
        },
      },
    });
    expect(JSON.parse(answerMockRequest(s, req("GET", "/pets")).body)).toEqual([{ name: "Rex" }]);
    expect(JSON.parse(answerMockRequest(s, req("GET", "/pets", { headers: { prefer: "example=two" } })).body)).toHaveLength(2);
  });

  it("forces a status", () => {
    const response = answerMockRequest(sample, req("GET", "/orders/1?__status=404"));
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body)).toHaveProperty("title");

    const undeclared = answerMockRequest(sample, req("GET", "/orders", { headers: { "x-mock-status": "500" } }));
    expect(undeclared.status).toBe(500);
    expect(undeclared.body).toBe("");
    expect(header(undeclared, WARNINGS_HEADER)).toMatch(/status 500 isn't declared/);
  });

  it("404s an unknown path with the closest operations", () => {
    const response = answerMockRequest(sample, req("GET", "/ordrs"));
    expect(response.status).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.error).toBe("No operation in Orders API (sample) matches GET /ordrs.");
    expect(body.closest[0]).toMatch(/\/orders$/);
  });

  it("405s a method the path doesn't take, with Allow", () => {
    const response = answerMockRequest(sample, req("DELETE", "/orders"));
    expect(response.status).toBe(405);
    expect(header(response, "allow")).toBe("GET, HEAD, POST");
    expect(JSON.parse(response.body).error).toBe("/orders doesn't take DELETE. The spec declares: GET, HEAD, POST.");
    // A non-preflight OPTIONS gets the list without an error.
    const options = answerMockRequest(sample, req("OPTIONS", "/orders"));
    expect(options.status).toBe(204);
    expect(header(options, "allow")).toBe("GET, HEAD, POST");
  });

  it("sends no body for HEAD or 204", () => {
    const head = answerMockRequest(sample, req("HEAD", "/orders"));
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
    const s = spec({ "/ping": { post: { responses: { "204": { description: "done" } } } } });
    expect(answerMockRequest(s, req("POST", "/ping"))).toMatchObject({ status: 204, body: "" });
  });

  it("serves text and declared response headers", () => {
    const s = spec({
      "/health": {
        get: {
          responses: {
            "200": {
              description: "ok",
              headers: { "X-Rate-Limit": { schema: { type: "integer", example: 60 } } },
              content: { "text/plain": { schema: { type: "string", example: "ok" } } },
            },
          },
        },
      },
    });
    const response = answerMockRequest(s, req("GET", "/health"));
    expect(response.body).toBe("ok");
    expect(header(response, "content-type")).toBe("text/plain");
    expect(header(response, "x-rate-limit")).toBe("60");
  });

  describe("request checks", () => {
    const good = JSON.stringify({ customerId: "c_1", lineItems: [{ sku: "A", quantity: 1, unitPrice: { amount: 1, currency: "USD" } }] });
    const json = { "content-type": "application/json" };

    it("a request that matches the spec gets no warnings", () => {
      const response = answerMockRequest(sample, req("POST", "/orders", { headers: json, body: good }));
      expect(response.status).toBe(201);
      expect(header(response, WARNINGS_HEADER)).toBeUndefined();
    });

    it("warns by default and still answers", () => {
      const response = answerMockRequest(
        sample,
        req("POST", "/orders?limit=x", { headers: json, body: JSON.stringify({ lineItems: [], extra: 1 }) }),
      );
      expect(response.status).toBe(201);
      const warnings = header(response, WARNINGS_HEADER)!;
      expect(warnings).toMatch(/missing required field `customerId`/);
      expect(warnings).toMatch(/`extra` isn't in the spec/);
    });

    it("checks parameters, bodies and content types", () => {
      const listed = answerMockRequest(sample, req("GET", "/orders?status=lost&limit=ten"));
      expect(header(listed, WARNINGS_HEADER)).toMatch(/query parameter `status` is "lost", not one of pending, paid, shipped, cancelled/);
      expect(header(listed, WARNINGS_HEADER)).toMatch(/query parameter `limit` should be an integer/);
      expect(header(answerMockRequest(sample, req("GET", "/orders/not-a-uuid")), WARNINGS_HEADER)).toMatch(/should be a UUID/);
      expect(header(answerMockRequest(sample, req("POST", "/orders", { headers: json })), WARNINGS_HEADER)).toMatch(
        /request body is required/,
      );
      expect(header(answerMockRequest(sample, req("POST", "/orders", { headers: json, body: "{" })), WARNINGS_HEADER)).toMatch(
        /isn't valid JSON/,
      );
      expect(
        header(answerMockRequest(sample, req("POST", "/orders", { headers: { "content-type": "text/plain" }, body: "x" })), WARNINGS_HEADER),
      ).toMatch(/Content-Type text\/plain isn't one the spec accepts/);
      expect(header(answerMockRequest(sample, req("GET", "/orders", { body: "x" })), WARNINGS_HEADER)).toMatch(/no request body/);
    });

    it("rejects with 400 when asked to", () => {
      const response = answerMockRequest(sample, req("POST", "/orders", { headers: json, body: "{}" }), { invalid: "reject" });
      expect(response.status).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toBe("The request doesn't match the spec for POST /orders.");
      expect(body.problems.join(" ")).toMatch(/customerId/);
      // A good request is still answered normally.
      expect(answerMockRequest(sample, req("POST", "/orders", { headers: json, body: good }), { invalid: "reject" }).status).toBe(201);
    });

    it("keeps the warnings header short and ASCII", () => {
      const many = Array.from({ length: 200 }, (_, index) => `problem ${index} — café\r\nX-Injected: 1`);
      const value = warningsHeader(many);
      expect(value.length).toBeLessThan(1600);
      expect(value).toMatch(/and \d+ more$/);
      expect(value).not.toMatch(/[\r\n]|[^\x20-\x7e]/);
    });
  });
});

describe("the local mock as a target", () => {
  const targets = [
    { label: "api.example.com/v1", url: "https://api.example.com/v1", kind: "server" as const },
    { label: "Mock server", url: "https://mock.example.com/m", kind: "mock" as const },
    { label: "staging", url: "https://staging.example.com", kind: "env" as const },
  ];

  it("is added after the servers and hosted mock, labelled with its address", () => {
    const next = withLocalMock(targets, localMockUrl(4010), localMockLabel(4010));
    expect(next.map((target) => target.kind)).toEqual(["server", "mock", "local-mock", "env"]);
    expect(next[2]).toEqual({ label: "Local mock · 127.0.0.1:4010", url: "http://127.0.0.1:4010", kind: "local-mock" });
  });

  it("is absent when no mock runs, and never duplicated", () => {
    expect(withLocalMock(targets, null, "")).toBe(targets);
    const once = withLocalMock(targets, localMockUrl(4010), localMockLabel(4010));
    expect(withLocalMock(once, "http://127.0.0.1:4010/", "again")).toBe(once);
  });
});
