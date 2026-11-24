import { describe, expect, it } from "vitest";
import { newCollection } from "../collection";
import { addScratchStep, linkStepsTo, linkStep } from "../collectionLink";
import {
  collectionSamples,
  describeSpec,
  hostsOf,
  isIdSegment,
  safeExample,
  scratchSamples,
  singular,
  suggestedSpecFileName,
  templatePaths,
  unlinkedSteps,
  type Sample,
} from "../describeSpec";
import type { HistoryEntry } from "../history";
import type { LibraryEntry } from "../library";
import { SCRATCH_OPERATION_ID, SCRATCH_TITLE } from "../scratch";
import { parseSpec } from "../spec";
import { validateResponse } from "../validate";

const ORIGIN = "https://api.example.com";
const json = { "content-type": "application/json; charset=utf-8" };

const sample = (method: string, path: string, over: Partial<Sample> = {}): Sample => ({
  method,
  url: `${ORIGIN}${path}`,
  headers: {},
  status: 200,
  responseHeaders: json,
  responseBody: "{}",
  ...over,
});

const body = (value: unknown) => JSON.stringify(value);

type Doc = {
  paths: Record<string, Record<string, Record<string, unknown> & { parameters?: Array<Record<string, unknown>> }>>;
  components?: { schemas?: Record<string, Record<string, unknown>>; securitySchemes?: Record<string, Record<string, unknown>> };
  servers: Array<{ url: string }>;
};
const docOf = (samples: Sample[], origin = ORIGIN) => describeSpec(samples, origin).doc as unknown as Doc;

describe("path templating", () => {
  it("knows an id from a name", () => {
    for (const id of ["1", "42", "3f2a9c0e-7b1d-4c3e-9a8f-0123456789ab", "5f8d0d55b54764421b7156c3", "cus_9s6XKzkNRiz8i3", "2026-11-24", "%7B%7BuserId%7D%7D"]) {
      expect(isIdSegment(id), id).toBe(true);
    }
    for (const name of ["users", "me", "order-items", "v1", "deadbeef-ish", "settings"]) {
      expect(isIdSegment(name), name).toBe(false);
    }
  });

  it("turns ids into parameters named after the segment before them, and merges what matches", () => {
    const described = describeSpec(
      [
        sample("GET", "/users/1"),
        sample("GET", "/users/2"),
        sample("DELETE", "/users/7", { status: 204, responseBody: "" }),
        sample("GET", "/users/2/posts/3f2a9c0e-7b1d-4c3e-9a8f-0123456789ab"),
      ],
      ORIGIN,
    );
    expect(described.operations.map((op) => `${op.method} ${op.path}`)).toEqual([
      "GET /users/{userId}",
      "DELETE /users/{userId}",
      "GET /users/{userId}/posts/{postId}",
    ]);
    const getUser = (described.doc as unknown as Doc).paths["/users/{userId}"].get;
    expect(getUser.parameters).toEqual([{ name: "userId", in: "path", required: true, schema: { type: "integer" }, example: 1 }]);
    expect(described.operations[0].samples).toBe(2);
    const post = (described.doc as unknown as Doc).paths["/users/{userId}/posts/{postId}"].get;
    expect(post.parameters?.[1]).toMatchObject({ name: "postId", schema: { type: "string", format: "uuid" } });
  });

  it("templates a word only when requests differ in it alone, with the same segment after it", () => {
    const paths = [
      ["users", "alice", "repos"],
      ["users", "bob", "repos"],
      ["users"],
      ["posts"],
      ["users", "me"],
      ["users", "settings"],
    ];
    expect(templatePaths(paths)).toEqual([
      [false, true, false],
      [false, true, false],
      [false],
      [false],
      [false, false],
      [false, false],
    ]);
  });

  it("names a parameter with no word before it id, and keeps names unique in a path", () => {
    const doc = docOf([sample("GET", "/v1/12/34")]);
    expect(Object.keys(doc.paths)).toEqual(["/v1/{id}/{id2}"]);
  });

  it("singularises well enough for names", () => {
    expect(["users", "categories", "statuses", "boxes", "address", "news", "data"].map(singular)).toEqual([
      "user",
      "category",
      "status",
      "box",
      "address",
      "new",
      "data",
    ]);
  });
});

describe("operations", () => {
  const described = describeSpec(
    [
      sample("GET", "/posts", { responseBody: body([{ id: 1, title: "a" }]) }),
      sample("GET", "/posts/1", { responseBody: body({ id: 1, title: "a" }) }),
      sample("POST", "/posts", { status: 201, body: body({ title: "a" }), headers: { "Content-Type": "application/json" }, responseBody: body({ id: 2, title: "a" }) }),
      sample("PUT", "/posts/1", { body: body({ title: "b" }) }),
      sample("PATCH", "/posts/1", { body: body({ title: "c" }) }),
      sample("GET", "/users/1/posts", { responseBody: body([{ id: 1, title: "a" }]) }),
      sample("GET", "/me", { responseBody: body({ name: "Ada" }) }),
      sample("GET", "/", { responseBody: body({ ok: true }) }),
    ],
    ORIGIN,
  );

  it("gets readable, unique operationIds", () => {
    expect(described.operations.map((op) => op.operationId)).toEqual([
      "getRoot",
      "getMe",
      "listPosts",
      "createPost",
      "getPost",
      "replacePost",
      "updatePost",
      "listUserPosts",
    ]);
    const twice = describeSpec([sample("GET", "/v1/posts"), sample("GET", "/v2/posts")], ORIGIN);
    expect(twice.operations.map((op) => op.operationId)).toEqual(["getPost", "getPost2"]);
  });

  it("keys responses by the status codes seen, and takes the server from the host", () => {
    const doc = docOf([
      sample("GET", "/posts/1", { status: 200, responseBody: body({ id: 1 }) }),
      sample("GET", "/posts/999", { status: 404, statusText: "Not Found", responseBody: body({ error: "missing" }) }),
    ]);
    expect(doc.servers).toEqual([{ url: ORIGIN }]);
    expect(Object.keys(doc.paths["/posts/{postId}"].get.responses as object)).toEqual(["200", "404"]);
    expect(doc.components?.schemas?.Error).toEqual({
      type: "object",
      properties: { error: { type: "string" } },
      required: ["error"],
    });
  });

  it("writes only samples to the chosen origin", () => {
    const doc = docOf([sample("GET", "/a"), { ...sample("GET", "/b"), url: "https://other.example.com/b" }]);
    expect(Object.keys(doc.paths)).toEqual(["/a"]);
  });

  it("says an operation that has no response yet hasn't been answered", () => {
    const doc = docOf([{ method: "GET", url: `${ORIGIN}/later`, tag: "s" }]);
    expect(doc.paths["/later"].get.responses).toEqual({ default: { description: "No response was recorded for this request yet." } });
  });
});

describe("query parameters", () => {
  it("lists every name seen, with a type from the values and required when always sent", () => {
    const doc = docOf([sample("GET", "/posts?userId=1&_limit=5&draft=true&tag=a&tag=b"), sample("GET", "/posts?userId=2&q=hi")]);
    expect(doc.paths["/posts"].get.parameters).toEqual([
      { name: "userId", in: "query", required: true, schema: { type: "integer" }, example: 1 },
      { name: "_limit", in: "query", schema: { type: "integer" }, example: 5 },
      { name: "draft", in: "query", schema: { type: "boolean" }, example: true },
      { name: "tag", in: "query", schema: { type: "array", items: { type: "string" } }, example: ["a"] },
      { name: "q", in: "query", schema: { type: "string" }, example: "hi" },
    ]);
  });
});

describe("schemas", () => {
  it("infers types, required fields, nullable fields as type arrays, and merged array items", () => {
    const doc = docOf([
      sample("GET", "/posts", {
        responseBody: body([
          { id: 1, title: "a", tags: ["x"], author: { name: "Ada" }, score: 1, publishedAt: "2026-01-02T03:04:05Z" },
          { id: 2, title: "b", tags: [], author: null, score: 1.5, publishedAt: "2026-01-02T03:04:05Z", extra: true },
        ]),
      }),
    ]);
    const response = (doc.paths["/posts"].get.responses as Record<string, { content: Record<string, { schema: unknown; example: unknown }> }>)["200"];
    const media = response.content["application/json"];
    expect(media.schema).toEqual({ type: "array", items: { $ref: "#/components/schemas/Post" } });
    expect(doc.components?.schemas?.Post).toEqual({
      type: "object",
      properties: {
        id: { type: "integer" },
        title: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        author: { type: ["object", "null"], properties: { name: { type: "string" } }, required: ["name"] },
        score: { type: "number" },
        publishedAt: { type: "string", format: "date-time" },
        extra: { type: "boolean" },
      },
      required: ["id", "title", "tags", "author", "score", "publishedAt"],
    });
    expect(media.example).toEqual([
      { id: 1, title: "a", tags: ["x"], author: { name: "Ada" }, score: 1, publishedAt: "2026-01-02T03:04:05Z" },
      { id: 2, title: "b", tags: [], author: null, score: 1.5, publishedAt: "2026-01-02T03:04:05Z", extra: true },
    ]);
  });

  it("shares a component between a list and an item, but not between unlike shapes", () => {
    const doc = docOf([
      sample("GET", "/posts", { responseBody: body([{ id: 1, title: "a", body: "x" }]) }),
      sample("GET", "/posts/1", { responseBody: body({ id: 1, title: "a" }) }),
      sample("POST", "/posts", { status: 201, body: body({ title: "a" }), responseBody: body({ page: 1, total: 9 }) }),
    ]);
    expect(Object.keys(doc.components?.schemas ?? {})).toEqual(["CreatePostResponse", "Post", "PostInput"]);
    expect(doc.components?.schemas?.Post.required).toEqual(["id", "title"]);
  });

  it("gives a body that isn't JSON its content type only", () => {
    const doc = docOf([
      sample("GET", "/page", { responseHeaders: { "content-type": "text/html" }, responseBody: "<html></html>" }),
      sample("POST", "/upload", { bodyKind: "form", body: "a=1", status: 204, responseBody: "" }),
    ]);
    expect(doc.paths["/page"].get.responses).toEqual({ "200": { description: "OK", content: { "text/html": {} } } });
    expect(doc.paths["/upload"].post.requestBody).toEqual({ required: true, content: { "application/x-www-form-urlencoded": {} } });
    expect(doc.paths["/upload"].post.responses).toEqual({ "204": { description: "No Content" } });
  });

  it("checks the responses it was written from as matching", () => {
    const responseBody = body([{ id: 1, title: "a", author: null }]);
    const described = describeSpec([sample("GET", "/posts", { responseBody }), sample("GET", "/posts/1", { responseBody: body({ id: 1, title: "a", author: { n: 1 } }) })], ORIGIN);
    const spec = parseSpec(described.yaml, "draft.yaml");
    expect(spec.version).toBe("0.1.0");
    expect(spec.operations.map((op) => op.operationId)).toEqual(["listPosts", "getPost"]);
    const list = spec.operations[0];
    const declared = list.responses.find((r) => r.status === "200");
    expect(validateResponse(spec.doc, declared?.schema, JSON.parse(responseBody)).status).toBe("ok");
    expect(validateResponse(spec.doc, declared?.schema, [{ id: "one" }]).status).toBe("mismatch");
  });
});

describe("secrets", () => {
  const TOKEN = "s3cr3t-bearer-value-123";
  const KEY = "k3y-in-a-header-456";
  const QUERY = "q-secret-789";
  const BASIC = btoa("ada:hunter2-password");
  const described = describeSpec(
    [
      sample("GET", `/me?api_key=${QUERY}&page=1&sig=abc123def456`, {
        headers: { Authorization: `Bearer ${TOKEN}`, "X-Api-Key": KEY, Cookie: "session=c00kie-value-000" },
        responseHeaders: { ...json, "set-cookie": "session=new-c00kie-value" },
        responseBody: body({ name: "Ada", token: "returned-token", echoed: `Bearer ${TOKEN}`, note: `key is ${KEY}`, apiKey: "x" }),
      }),
      sample("GET", "/accounts/1", { headers: { authorization: `Basic ${BASIC}` }, responseBody: body({ owner: "ada:hunter2-password", id: 1 }) }),
      sample("GET", "/public"),
      sample("POST", "/sessions", { body: body({ user: "ada", password: "hunter2-password" }), responseBody: body({ access_token: "eyJhbGciOi.eyJzdWIiOi.sig" }) }),
    ],
    ORIGIN,
  );

  it("never writes a credential into the document or its examples", () => {
    for (const secret of [TOKEN, KEY, QUERY, BASIC, "hunter2", "c00kie", "returned-token", "eyJhbGciOi", "abc123def456"]) {
      expect(described.yaml, secret).not.toContain(secret);
    }
    expect(described.yaml).not.toMatch(/set-cookie|Cookie:|X-Api-Key: /i);
  });

  it("adds a security scheme for each kind of auth seen, without a value", () => {
    const doc = described.doc as unknown as Doc;
    expect(doc.components?.securitySchemes).toEqual({
      bearerAuth: { type: "http", scheme: "bearer" },
      xApiKey: { type: "apiKey", in: "header", name: "X-Api-Key" },
      apiKey: { type: "apiKey", in: "query", name: "api_key" },
      sig: { type: "apiKey", in: "query", name: "sig" },
      basicAuth: { type: "http", scheme: "basic" },
    });
    expect(doc.paths["/me"].get.security).toEqual([{ bearerAuth: [], xApiKey: [], apiKey: [], sig: [] }]);
    expect(doc.paths["/accounts/{accountId}"].get.security).toEqual([{ basicAuth: [] }]);
    expect(doc.paths["/public"].get.security).toBeUndefined();
    // The query secret isn't a parameter; the page is.
    expect(doc.paths["/me"].get.parameters).toEqual([{ name: "page", in: "query", required: true, schema: { type: "integer" }, example: 1 }]);
  });

  it("keeps the shape of a secret field but not its value", () => {
    const doc = described.doc as unknown as Doc;
    expect(Object.keys((doc.components?.schemas?.Me.properties as object) ?? {})).toContain("token");
    const media = (doc.paths["/me"].get.responses as Record<string, { content: Record<string, { example: unknown }> }>)["200"].content["application/json"];
    expect(media.example).toEqual({ name: "Ada" });
    expect(described.leftOut).toEqual(
      expect.arrayContaining(["the Authorization header", "the X-Api-Key header", "the Cookie header", "the api_key query parameter"]),
    );
  });

  it("treats {{references}} and token-like strings as secrets in examples", () => {
    expect(safeExample({ a: "{{token}}", b: "plain", c: "ghp_abcdefghijklmnop1234", d: ["x", "y", "z", "w"] })).toEqual({ b: "plain", d: ["x", "y", "z"] });
    expect(safeExample("contains the value", new Set(["the value"]))).toBeUndefined();
  });

  it("documents a path segment sent as a reference without its value", () => {
    const doc = docOf([sample("GET", "/users/%7B%7BuserId%7D%7D")]);
    expect(doc.paths["/users/{userId}"].get.parameters).toEqual([{ name: "userId", in: "path", required: true, schema: { type: "string" } }]);
  });
});

describe("hosts and samples", () => {
  const entry = (over: Partial<HistoryEntry>): HistoryEntry => ({
    id: Math.random().toString(36),
    at: "2026-11-24T10:00:00Z",
    method: "GET",
    path: "/x",
    url: `${ORIGIN}/x`,
    status: 200,
    ms: 1,
    bytes: 1,
    specTitle: SCRATCH_TITLE,
    operationId: SCRATCH_OPERATION_ID,
    headers: {},
    ...over,
  });

  it("lists hosts busiest first", () => {
    expect(hostsOf([sample("GET", "/a"), { ...sample("GET", "/"), url: "http://localhost:8080/" }, sample("GET", "/b"), { ...sample("GET", "/"), url: "not a url" }])).toEqual([
      { origin: ORIGIN, host: "api.example.com", count: 2 },
      { origin: "http://localhost:8080", host: "localhost:8080", count: 1 },
    ]);
  });

  it("takes scratch calls that got an answer, and nothing spec-driven", () => {
    const samples = scratchSamples([entry({}), entry({ status: 0 }), entry({ operationId: "GET /x", apiId: "a" })]);
    expect(samples).toHaveLength(1);
  });

  it("takes a collection's unlinked steps, from their runs or from the step", () => {
    let collection = addScratchStep(newCollection("Try"), { method: "GET", url: `${ORIGIN}/users/1`, headers: [], body: "" });
    collection = addScratchStep(collection, { method: "GET", url: "{{base}}/users/2/posts?key={{apiKey}}", headers: [], body: "" });
    const [first, second] = collection.steps;
    const history = [
      entry({ url: `${ORIGIN}/users/1`, collection: { id: collection.id, name: "Try", step: first.key, index: 0, total: 2, passed: true } }),
      entry({ url: `${ORIGIN}/users/9`, collection: { id: "other", name: "Other", step: first.key, index: 0, total: 1, passed: true } }),
    ];
    const samples = collectionSamples(collection, history, { base: ORIGIN });
    expect(samples.map((s) => [s.tag, s.url])).toEqual([
      [first.key, `${ORIGIN}/users/1`],
      [second.key, `${ORIGIN}/users/2/posts?key={{apiKey}}`],
    ]);
    expect(unlinkedSteps(collection)).toBe(2);
  });
});

describe("linking a collection to the spec it described", () => {
  it("links each unlinked step to its new operation, so its response is checked", () => {
    let collection = addScratchStep(newCollection("Try"), { method: "GET", url: `${ORIGIN}/users/1`, headers: [], body: "" });
    collection = addScratchStep(collection, { method: "POST", url: `${ORIGIN}/users`, headers: [], body: '{"name":"Ada"}' });
    collection = addScratchStep(collection, { method: "GET", url: "https://elsewhere.example.com/x", headers: [], body: "" });
    const samples = collectionSamples(collection, []);
    const described = describeSpec(samples, ORIGIN);
    const spec = parseSpec(described.yaml, "draft.yaml");
    const library: LibraryEntry = {
      id: "file_1",
      title: spec.title,
      version: spec.version,
      source: { kind: "file", ref: "/tmp/api-example-com.openapi.yaml" },
      operations: spec.operations.length,
      schemas: spec.schemas.length,
      addedAt: "",
      openedAt: "",
    };
    const { collection: linked, linked: count } = linkStepsTo(collection, library, spec, described.byTag);
    expect(count).toBe(2);
    expect(linked.steps[0]).toMatchObject({ operation: { operationId: "getUser", method: "GET", path: "/users/{userId}" }, pathParams: { userId: "1" } });
    expect(linked.steps[1]).toMatchObject({ operation: { operationId: "createUser" }, body: '{"name":"Ada"}' });
    expect(linked.steps[2].api).toBeUndefined();
    const specs = new Map([[library.id, spec]]);
    expect(linkStep(linked.steps[0], linked, [library], specs).kind).toBe("ok");
    expect(linkStep(linked.steps[1], linked, [library], specs).kind).toBe("ok");
  });
});

describe("suggestedSpecFileName", () => {
  it("names the file after the host", () => {
    expect(suggestedSpecFileName("jsonplaceholder.typicode.com")).toBe("jsonplaceholder-typicode-com.openapi.yaml");
    expect(suggestedSpecFileName("localhost:8080")).toBe("localhost.openapi.yaml");
  });
});
