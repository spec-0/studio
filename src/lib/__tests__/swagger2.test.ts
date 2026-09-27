import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { SWAGGER2_CONVERT_COMMAND, openapiText, parseDocument, parseSpec, type Json } from "../spec";
import { convertSwagger2, isSwagger2 } from "../swagger2";
import { validateResponse } from "../validate";

// The classic Swagger Petstore (https://petstore.swagger.io/v2/swagger.json),
// Apache 2.0 as its `info.license` says. Saved once so the test runs offline.
const here = dirname(fileURLToPath(import.meta.url));
const petstoreText = readFileSync(resolve(here, "fixtures/petstore-swagger2.json"), "utf8");
const petstore = () => JSON.parse(petstoreText) as Json;

/** A minimal Swagger 2.0 document with `extra` merged in. */
const swagger = (extra: Json = {}): Json => ({
  swagger: "2.0",
  info: { title: "Orders", version: "1.0" },
  host: "api.example.com",
  schemes: ["https"],
  paths: {},
  ...extra,
});

/** Every `$ref` in a document. */
function refs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((item) => refs(item, out));
  else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") out.push(value);
      else refs(value, out);
    }
  }
  return out;
}

describe("the Swagger Petstore (v2)", () => {
  const { doc, notes } = convertSwagger2(petstore());

  it("becomes an OpenAPI 3.0 document with the same info", () => {
    expect(doc.openapi).toBe("3.0.3");
    expect(doc.swagger).toBeUndefined();
    expect(doc.info.title).toBe("Swagger Petstore");
    expect(doc.tags.map((t: Json) => t.name)).toEqual(["pet", "store", "user"]);
    expect(notes).toEqual([]);
  });

  it("turns host, basePath and schemes into servers, https first", () => {
    expect(doc.servers).toEqual([
      { url: "https://petstore.swagger.io/v2" },
      { url: "http://petstore.swagger.io/v2" },
    ]);
  });

  it("moves definitions to components and every $ref with them", () => {
    expect(Object.keys(doc.components.schemas).sort()).toEqual(
      ["ApiResponse", "Category", "Order", "Pet", "Tag", "User"],
    );
    const all = refs(doc);
    expect(all.length).toBeGreaterThan(10);
    expect(all.every((ref) => ref.startsWith("#/components/schemas/"))).toBe(true);
    expect(doc.components.schemas.Pet.properties.category.$ref).toBe("#/components/schemas/Category");
  });

  it("turns a body parameter into a request body for each consumed type", () => {
    const body = doc.paths["/pet"].post.requestBody;
    expect(body.required).toBe(true);
    expect(Object.keys(body.content)).toEqual(["application/json", "application/xml"]);
    expect(body.content["application/json"].schema.$ref).toBe("#/components/schemas/Pet");
    expect(doc.paths["/pet"].post.parameters).toBeUndefined();
  });

  it("turns form parameters into a form body, with a file as binary", () => {
    const form = doc.paths["/pet/{petId}"].post.requestBody.content["application/x-www-form-urlencoded"];
    expect(Object.keys(form.schema.properties)).toEqual(["name", "status"]);

    const upload = doc.paths["/pet/{petId}/uploadImage"].post;
    expect(upload.parameters.map((p: Json) => p.name)).toEqual(["petId"]);
    const multipart = upload.requestBody.content["multipart/form-data"].schema;
    expect(multipart.properties.file).toMatchObject({ type: "string", format: "binary" });
    expect(multipart.properties.additionalMetadata.type).toBe("string");
  });

  it("gives parameters a schema, and a multi array the form style", () => {
    const status = doc.paths["/pet/findByStatus"].get.parameters[0];
    expect(status).toMatchObject({
      name: "status",
      in: "query",
      required: true,
      style: "form",
      explode: true,
      schema: { type: "array", items: { type: "string", enum: ["available", "pending", "sold"] } },
    });
    expect(status.type).toBeUndefined();
    expect(doc.paths["/pet/{petId}"].get.parameters[0].schema).toEqual({ type: "integer", format: "int64" });
  });

  it("puts response schemas under each produced type, and keeps headers", () => {
    const ok = doc.paths["/pet/{petId}"].get.responses["200"];
    expect(Object.keys(ok.content)).toEqual(["application/json", "application/xml"]);
    expect(ok.content["application/json"].schema.$ref).toBe("#/components/schemas/Pet");
    expect(doc.paths["/pet/{petId}"].get.responses["404"]).toEqual({ description: "Pet not found" });

    const login = doc.paths["/user/login"].get.responses["200"];
    expect(login.headers["X-Rate-Limit"]).toEqual({
      description: "calls per hour allowed by the user",
      schema: { type: "integer", format: "int32" },
    });
  });

  it("converts the API key and the OAuth 2.0 implicit flow", () => {
    expect(doc.components.securitySchemes.api_key).toEqual({ type: "apiKey", name: "api_key", in: "header" });
    expect(doc.components.securitySchemes.petstore_auth).toEqual({
      type: "oauth2",
      flows: {
        implicit: {
          authorizationUrl: "https://petstore.swagger.io/oauth/authorize",
          scopes: { "read:pets": "read your pets", "write:pets": "modify pets in your account" },
        },
      },
    });
  });

  it("opens in Studio like any OpenAPI 3 spec, and says it was converted", () => {
    const spec = parseSpec(petstoreText, "petstore.json");
    expect(spec.converted).toEqual({ from: "Swagger 2.0", notes: [] });
    expect(spec.operations).toHaveLength(20);
    expect(spec.schemas).toHaveLength(6);
    expect(spec.servers[0]).toBe("https://petstore.swagger.io/v2");

    const addPet = spec.operations.find((op) => op.id === "POST /pet")!;
    expect(addPet.requestBody).toMatchObject({ required: true, contentType: "application/json" });
    const upload = spec.operations.find((op) => op.id === "POST /pet/{petId}/uploadImage")!;
    expect(upload.requestBody?.contentType).toBe("multipart/form-data");

    const auth = spec.securitySchemes.find((s) => s.name === "petstore_auth")!;
    expect(auth.flows?.[0]).toMatchObject({ kind: "implicit", authorizationUrl: "https://petstore.swagger.io/oauth/authorize" });
    expect(spec.schemas.find((s) => s.name === "Pet")!.usedIn).toBeGreaterThan(0);
  });

  it("checks responses against the converted schemas", () => {
    const spec = parseSpec(petstoreText, "petstore.json");
    const getPet = spec.operations.find((op) => op.id === "GET /pet/{petId}")!;
    const schema = getPet.responses.find((r) => r.status === "200")!.schema;
    const good = { id: 1, name: "Rex", photoUrls: [], status: "available" };
    expect(validateResponse(spec.doc, schema, good).status).toBe("ok");
    expect(validateResponse(spec.doc, schema, { id: 1 }).status).toBe("mismatch");
  });

  it("keeps the imported text as the source, and writes the conversion as JSON", () => {
    const spec = parseSpec(petstoreText, "petstore.json");
    expect(spec.sourceText).toBe(petstoreText);
    const text = openapiText(spec);
    expect(text.trimStart().startsWith("{")).toBe(true);
    expect(JSON.parse(text)).toEqual(spec.doc);
    expect(openapiText(spec)).toBe(text);
  });
});

describe("servers", () => {
  it("assumes https when no schemes are listed, and says so", () => {
    const { doc, notes } = convertSwagger2(swagger({ schemes: undefined, basePath: "/v1/" }));
    expect(doc.servers).toEqual([{ url: "https://api.example.com/v1" }]);
    expect(notes).toEqual([expect.stringContaining("assumed https")]);
  });

  it("uses the scheme the document was fetched with, when it was fetched", () => {
    const { doc, notes } = convertSwagger2(swagger({ schemes: undefined }), {
      documentUrl: "http://internal.example.com/swagger.json",
    });
    expect(doc.servers).toEqual([{ url: "http://api.example.com" }]);
    expect(notes).toEqual([]);
  });

  it("keeps a spec with no host relative, so it resolves against where it came from", () => {
    const { doc } = convertSwagger2(swagger({ host: undefined, basePath: "/api" }));
    expect(doc.servers).toEqual([{ url: "/api" }]);
    const text = JSON.stringify(swagger({ host: undefined, basePath: "/api" }));
    expect(parseSpec(text, "s", "https://svc.example.com/docs/swagger.json").servers).toEqual([
      "https://svc.example.com/api",
    ]);
  });

  it("gives an operation with its own schemes its own servers", () => {
    const { doc } = convertSwagger2(
      swagger({ basePath: "/v1", paths: { "/ws": { get: { schemes: ["wss"], responses: { 101: { description: "Up" } } } } } }),
    );
    expect(doc.paths["/ws"].get.servers).toEqual([{ url: "wss://api.example.com/v1" }]);
  });
});

describe("shared parameters and responses", () => {
  const source = swagger({
    consumes: ["application/json"],
    produces: ["application/json"],
    parameters: {
      limit: { name: "limit", in: "query", type: "integer", minimum: 1 },
      order: { name: "order", in: "body", required: true, schema: { $ref: "#/definitions/Order" } },
      note: { name: "note", in: "formData", type: "string" },
    },
    responses: {
      NotFound: { description: "Not found", schema: { $ref: "#/definitions/Error" } },
    },
    definitions: {
      Order: { type: "object", properties: { id: { type: "string" } } },
      Error: { type: "object", properties: { message: { type: "string" } } },
    },
    paths: {
      "/orders": {
        get: {
          parameters: [{ $ref: "#/parameters/limit" }],
          responses: { 200: { description: "OK" }, 404: { $ref: "#/responses/NotFound" } },
        },
        post: {
          parameters: [{ $ref: "#/parameters/order" }],
          responses: { 201: { description: "Created" } },
        },
        put: {
          consumes: ["application/vnd.orders+json"],
          parameters: [{ $ref: "#/parameters/order" }],
          responses: { 200: { description: "OK" } },
        },
      },
      "/orders/{id}/notes": {
        post: {
          consumes: ["application/x-www-form-urlencoded"],
          parameters: [{ $ref: "#/parameters/note" }, { name: "id", in: "path", type: "string" }],
          responses: { 204: { description: "Added" } },
        },
      },
    },
  });
  const { doc } = convertSwagger2(source);

  it("keeps ordinary parameters shared, under components.parameters", () => {
    expect(doc.components.parameters.limit).toEqual({
      name: "limit",
      in: "query",
      schema: { type: "integer", minimum: 1 },
    });
    expect(doc.paths["/orders"].get.parameters).toEqual([{ $ref: "#/components/parameters/limit" }]);
  });

  it("keeps a shared body shared, as a request body component", () => {
    expect(doc.components.requestBodies.order).toEqual({
      required: true,
      content: { "application/json": { schema: { $ref: "#/components/schemas/Order" } } },
    });
    expect(doc.paths["/orders"].post.requestBody).toEqual({ $ref: "#/components/requestBodies/order" });
  });

  it("inlines a shared body where the operation takes a different media type", () => {
    expect(Object.keys(doc.paths["/orders"].put.requestBody.content)).toEqual(["application/vnd.orders+json"]);
  });

  it("inlines shared form fields, which have no component in OpenAPI 3", () => {
    expect(doc.components.parameters.note).toBeUndefined();
    const op = doc.paths["/orders/{id}/notes"].post;
    expect(op.requestBody.content["application/x-www-form-urlencoded"].schema.properties.note.type).toBe("string");
    expect(op.parameters).toEqual([{ name: "id", in: "path", required: true, schema: { type: "string" } }]);
  });

  it("moves shared responses to components.responses", () => {
    expect(doc.components.responses.NotFound.content["application/json"].schema.$ref).toBe(
      "#/components/schemas/Error",
    );
    expect(doc.paths["/orders"].get.responses["404"]).toEqual({ $ref: "#/components/responses/NotFound" });
  });

  it("leaves no Swagger 2.0 pointer behind, and every pointer resolves", () => {
    for (const ref of refs(doc)) {
      expect(ref).toMatch(/^#\/components\/(schemas|parameters|requestBodies|responses)\//);
      const [, , kind, name] = ref.split("/");
      expect(doc.components[kind][name], ref).toBeDefined();
    }
  });

  it("gives Studio the operations it expects", () => {
    const spec = parseSpec(JSON.stringify(source), "orders.json");
    const list = spec.operations.find((op) => op.id === "GET /orders")!;
    expect(list.parameters).toEqual([
      { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1 }, description: undefined },
    ]);
    const create = spec.operations.find((op) => op.id === "POST /orders")!;
    expect(create.requestBody).toMatchObject({ required: true, contentType: "application/json" });
    expect(list.responses.find((r) => r.status === "404")?.schema?.$ref).toBe("#/components/schemas/Error");
  });
});

describe("path-level parameters", () => {
  const { doc } = convertSwagger2(
    swagger({
      paths: {
        "/items/{id}": {
          parameters: [
            { name: "id", in: "path", required: true, type: "string" },
            { name: "item", in: "body", schema: { type: "object" } },
          ],
          get: { responses: { 200: { description: "OK" } } },
          put: {
            parameters: [{ name: "item", in: "body", required: true, schema: { $ref: "#/definitions/Item" } }],
            responses: { 200: { description: "OK" } },
          },
        },
      },
    }),
  );

  it("stay at path level, once, without the body", () => {
    expect(doc.paths["/items/{id}"].parameters).toEqual([
      { name: "id", in: "path", required: true, schema: { type: "string" } },
    ]);
    expect(doc.paths["/items/{id}"].get.parameters).toBeUndefined();
  });

  it("give each operation the path's body, unless it declares its own", () => {
    expect(doc.paths["/items/{id}"].get.requestBody.content["application/json"].schema).toEqual({ type: "object" });
    expect(doc.paths["/items/{id}"].put.requestBody).toMatchObject({
      required: true,
      content: { "application/json": { schema: { $ref: "#/components/schemas/Item" } } },
    });
  });
});

describe("schemas", () => {
  const { doc } = convertSwagger2(
    swagger({
      definitions: {
        Pet: {
          type: "object",
          discriminator: "kind",
          properties: {
            kind: { type: "string" },
            nickname: { type: "string", "x-nullable": true },
            photo: { type: "file" },
            owner: { $ref: "#/definitions/Owner" },
            tags: { type: "array", items: { $ref: "#/definitions/Tag" } },
            extra: { type: "object", additionalProperties: { $ref: "#/definitions/Tag" } },
          },
        },
        Cat: { allOf: [{ $ref: "#/definitions/Pet" }, { type: "object", properties: { lives: { type: "integer" } } }] },
        Owner: { type: "object", "x-vendor": { keep: true } },
        Tag: { type: "string" },
      },
    }),
  );
  const pet = doc.components.schemas.Pet;

  it("turns x-nullable into nullable, and a string discriminator into an object", () => {
    expect(pet.properties.nickname).toEqual({ type: "string", nullable: true });
    expect(pet.discriminator).toEqual({ propertyName: "kind" });
  });

  it("turns type: file into a binary string", () => {
    expect(pet.properties.photo).toEqual({ type: "string", format: "binary" });
  });

  it("rewrites references at any depth, and keeps extensions", () => {
    expect(pet.properties.owner.$ref).toBe("#/components/schemas/Owner");
    expect(pet.properties.tags.items.$ref).toBe("#/components/schemas/Tag");
    expect(pet.properties.extra.additionalProperties.$ref).toBe("#/components/schemas/Tag");
    expect(doc.components.schemas.Cat.allOf[0].$ref).toBe("#/components/schemas/Pet");
    expect(doc.components.schemas.Owner["x-vendor"]).toEqual({ keep: true });
  });
});

describe("parameters", () => {
  const param = (extra: Json) => {
    const { doc, notes } = convertSwagger2(
      swagger({ paths: { "/p": { get: { parameters: [{ name: "v", in: "query", ...extra }], responses: {} } } } }),
    );
    return { param: doc.paths["/p"].get.parameters[0], notes };
  };

  it("maps array separators onto OpenAPI 3 styles", () => {
    const array = { type: "array", items: { type: "string" } };
    expect(param({ ...array }).param).toMatchObject({ style: "form", explode: false });
    expect(param({ ...array, collectionFormat: "ssv" }).param).toMatchObject({ style: "spaceDelimited", explode: false });
    expect(param({ ...array, collectionFormat: "pipes" }).param).toMatchObject({ style: "pipeDelimited", explode: false });
    expect(param({ ...array, collectionFormat: "multi" }).param).toMatchObject({ style: "form", explode: true });
  });

  it("says so when a separator has no OpenAPI 3 equivalent", () => {
    const { param: tsv, notes } = param({ type: "array", items: { type: "string" }, collectionFormat: "tsv" });
    expect(tsv.style).toBeUndefined();
    expect(notes).toEqual([expect.stringContaining("tsv")]);
  });

  it("keeps validation keywords in the schema and x-example as the example", () => {
    const { param: p } = param({ type: "string", enum: ["a", "b"], default: "a", pattern: "^[ab]$", "x-example": "b" });
    expect(p.schema).toEqual({ type: "string", enum: ["a", "b"], default: "a", pattern: "^[ab]$" });
    expect(p.example).toBe("b");
  });
});

describe("request and response media types", () => {
  it("defaults to JSON when nothing is declared", () => {
    const { doc } = convertSwagger2(
      swagger({
        paths: {
          "/x": {
            post: {
              parameters: [{ name: "b", in: "body", schema: { type: "object" } }],
              responses: { 200: { description: "OK", schema: { type: "object" } } },
            },
          },
        },
      }),
    );
    expect(Object.keys(doc.paths["/x"].post.requestBody.content)).toEqual(["application/json"]);
    expect(Object.keys(doc.paths["/x"].post.responses["200"].content)).toEqual(["application/json"]);
  });

  it("uses multipart for form fields with a file when no form type is declared", () => {
    const { doc } = convertSwagger2(
      swagger({
        paths: { "/u": { post: { parameters: [{ name: "f", in: "formData", type: "file", required: true }], responses: {} } } },
      }),
    );
    const body = doc.paths["/u"].post.requestBody;
    expect(body.required).toBe(true);
    expect(body.content["multipart/form-data"].schema).toEqual({
      type: "object",
      properties: { f: { type: "string", format: "binary" } },
      required: ["f"],
    });
  });

  it("keeps response examples, and a media type only an example mentions", () => {
    const { doc } = convertSwagger2(
      swagger({
        produces: ["application/octet-stream"],
        paths: {
          "/e": {
            get: {
              responses: {
                404: {
                  description: "Missing",
                  schema: { $ref: "#/definitions/Error" },
                  examples: { "application/json": { message: "no such thing" } },
                },
              },
            },
          },
        },
      }),
    );
    const content = doc.paths["/e"].get.responses["404"].content;
    expect(Object.keys(content)).toEqual(["application/octet-stream", "application/json"]);
    expect(content["application/json"]).toEqual({
      schema: { $ref: "#/components/schemas/Error" },
      example: { message: "no such thing" },
    });
  });
});

describe("security definitions", () => {
  const { doc } = convertSwagger2(
    swagger({
      securityDefinitions: {
        basic: { type: "basic", description: "Username and password" },
        password: { type: "oauth2", flow: "password", tokenUrl: "https://auth.example.com/token", scopes: { read: "Read" } },
        machine: { type: "oauth2", flow: "application", tokenUrl: "https://auth.example.com/token", scopes: {} },
        code: {
          type: "oauth2",
          flow: "accessCode",
          authorizationUrl: "https://auth.example.com/authorize",
          tokenUrl: "https://auth.example.com/token",
          scopes: { write: "Write" },
        },
      },
      security: [{ basic: [] }],
    }),
  );
  const schemes = doc.components.securitySchemes;

  it("turns basic into HTTP basic", () => {
    expect(schemes.basic).toEqual({ type: "http", scheme: "basic", description: "Username and password" });
    expect(doc.security).toEqual([{ basic: [] }]);
  });

  it("renames the OAuth 2.0 flows", () => {
    expect(schemes.password.flows).toEqual({ password: { tokenUrl: "https://auth.example.com/token", scopes: { read: "Read" } } });
    expect(schemes.machine.flows).toEqual({ clientCredentials: { tokenUrl: "https://auth.example.com/token", scopes: {} } });
    expect(schemes.code.flows).toEqual({
      authorizationCode: {
        authorizationUrl: "https://auth.example.com/authorize",
        tokenUrl: "https://auth.example.com/token",
        scopes: { write: "Write" },
      },
    });
  });

  it("gives Studio's OAuth settings the flows it can pre-fill", () => {
    const spec = parseSpec(JSON.stringify(swagger({ securityDefinitions: { code: { type: "oauth2", flow: "accessCode", authorizationUrl: "https://a/authorize", tokenUrl: "https://a/token", scopes: {} } } })), "s");
    expect(spec.securitySchemes[0].flows?.[0]).toMatchObject({ kind: "authorizationCode", tokenUrl: "https://a/token" });
  });
});

describe("opening a Swagger 2.0 file", () => {
  const yaml = [
    "swagger: '2.0'",
    "info: {title: Old, version: '1'}",
    "host: old.example.com",
    "schemes: [https]",
    "paths:",
    "  /ping:",
    "    get:",
    "      responses:",
    "        '200': {description: pong, schema: {type: string}}",
    "",
  ].join("\n");

  it("reads YAML, and writes the conversion back out as YAML", () => {
    const spec = parseSpec(yaml, "old.yaml");
    expect(spec.converted?.from).toBe("Swagger 2.0");
    expect(spec.operations.map((op) => op.id)).toEqual(["GET /ping"]);
    expect(spec.sourceText).toBe(yaml);
    const text = openapiText(spec);
    expect(text.startsWith("openapi: 3.0.3")).toBe(true);
    expect(load(text)).toEqual(spec.doc);
  });

  it("leaves an OpenAPI 3 document alone", () => {
    const text = '{"openapi":"3.1.0","info":{"title":"t","version":"1"},"paths":{}}';
    const spec = parseSpec(text, "t.json");
    expect(spec.converted).toBeUndefined();
    expect(openapiText(spec)).toBe(text);
    expect(isSwagger2(spec.doc)).toBe(false);
  });

  it("explains a document it can't convert, with the local command as a way out", () => {
    const old = JSON.stringify({ swagger: "1.2", info: { title: "Older", version: "1" }, paths: {} });
    expect(() => parseDocument(old)).toThrow(/couldn't convert this Swagger 2\.0 document/);
    expect(() => parseDocument(old)).toThrow(SWAGGER2_CONVERT_COMMAND);
  });
});
