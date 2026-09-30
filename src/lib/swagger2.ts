/**
 * Swagger 2.0 → OpenAPI 3.0, done when a spec is opened.
 *
 * A small converter of our own rather than `swagger2openapi`: that package is
 * written for Node (it pulls in an HTTP client, a CLI parser and a validator)
 * and would have to be shimmed to run in the web view. This one is a pure
 * function over the parsed document, so it makes no requests, needs nothing
 * from Node, and runs under the app's security policy like the rest of
 * `src/lib`.
 *
 * It covers what real Swagger 2.0 specs use: host/basePath/schemes as
 * servers, definitions, shared parameters and responses as components,
 * `body` and `formData` parameters as request bodies, consumes/produces as
 * media types, security definitions (all four OAuth 2.0 flows), and `$ref`s
 * rewritten to their new places. Anything it had to guess is returned in
 * `notes`, so the interface can say so instead of presenting a guess as fact.
 *
 * The original document is never changed; the caller keeps the imported text.
 */

import type { Json } from "./spec";

export interface Swagger2Conversion {
  /** The OpenAPI 3.0.3 document. */
  doc: Json;
  /** Where the conversion had to guess or drop something, in plain words. */
  notes: string[];
}

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch"];
const FORM_TYPES = ["application/x-www-form-urlencoded", "multipart/form-data"];

/** Keywords a Swagger 2.0 parameter or header shares with a JSON Schema. */
const SCHEMA_KEYS = [
  "type",
  "format",
  "items",
  "default",
  "maximum",
  "exclusiveMaximum",
  "minimum",
  "exclusiveMinimum",
  "maxLength",
  "minLength",
  "pattern",
  "maxItems",
  "minItems",
  "uniqueItems",
  "enum",
  "multipleOf",
];

const isObject = (value: unknown): value is Json =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** `x-…` fields, carried across unchanged wherever they appear. */
function extensions(node: Json): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(node)) if (key.startsWith("x-")) out[key] = value;
  return out;
}

/** Copy the listed fields that are present. */
function pick(node: Json, keys: string[]): Json {
  const out: Json = {};
  for (const key of keys) if (node[key] !== undefined) out[key] = node[key];
  return out;
}

/** A local `#/…` pointer's last segment, unescaped. */
function refName(ref: string): string {
  return (ref.split("/").pop() ?? "").replace(/~1/g, "/").replace(/~0/g, "~");
}

/** Whether a document is Swagger 2.0 (as opposed to OpenAPI 3). */
export function isSwagger2(doc: Json): boolean {
  return doc.swagger !== undefined && doc.openapi === undefined;
}

export function convertSwagger2(source: Json, options: { documentUrl?: string } = {}): Swagger2Conversion {
  if (String(source.swagger).trim() !== "2.0") {
    throw new Error(
      `This document says it is Swagger ${String(source.swagger)}. Studio can convert Swagger 2.0, not earlier versions.`,
    );
  }
  const notes = new Set<string>();
  const globalConsumes: string[] = Array.isArray(source.consumes) ? source.consumes : [];
  const globalProduces: string[] = Array.isArray(source.produces) ? source.produces : [];
  const sharedParams: Json = isObject(source.parameters) ? source.parameters : {};

  /** Rewrite a `$ref` to where the same thing lives in OpenAPI 3. */
  const rewriteRef = (ref: string): string => {
    if (ref.startsWith("#/definitions/")) return `#/components/schemas/${ref.slice("#/definitions/".length)}`;
    if (ref.startsWith("#/responses/")) return `#/components/responses/${ref.slice("#/responses/".length)}`;
    if (ref.startsWith("#/parameters/")) {
      const name = ref.slice("#/parameters/".length);
      const target = sharedParams[refName(ref)];
      return target?.in === "body"
        ? `#/components/requestBodies/${name}`
        : `#/components/parameters/${name}`;
    }
    if (!ref.startsWith("#")) notes.add("References to other files are kept as written; Studio doesn't follow them.");
    return ref;
  };

  // Schemas

  /**
   * A Swagger 2.0 schema as an OpenAPI 3.0 schema. The two are nearly the same
   * dialect; the differences are `type: file`, `x-nullable`, a string
   * `discriminator` and where `$ref`s point.
   */
  const schema = (node: unknown): any => {
    if (Array.isArray(node)) return node.map(schema);
    if (!isObject(node)) return node;
    const out: Json = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") out.$ref = rewriteRef(value);
      else if (key === "x-nullable") out.nullable = value;
      else if (key === "discriminator" && typeof value === "string") out.discriminator = { propertyName: value };
      else if (key === "properties" || key === "patternProperties" || key === "definitions") {
        out[key] = isObject(value)
          ? Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, schema(sub)]))
          : value;
      } else if (
        key === "items" ||
        key === "additionalProperties" ||
        key === "allOf" ||
        key === "anyOf" ||
        key === "oneOf" ||
        key === "not"
      ) {
        out[key] = schema(value);
      } else out[key] = value;
    }
    if (out.type === "file") {
      out.type = "string";
      out.format = "binary";
    }
    // OpenAPI 3.0 has no `$ref` siblings; Swagger 2.0 didn't either, but specs
    // add them. Leave them: Studio's own reader follows the `$ref` and the
    // extra fields are harmless.
    return out;
  };

  /**
   * The schema part of a non-body parameter, header or `items`: in Swagger 2.0
   * those fields sit on the parameter itself.
   */
  const inlineSchema = (node: Json): Json => {
    const out = pick(node, SCHEMA_KEYS);
    if (isObject(out.items)) out.items = inlineSchema(out.items);
    if (out.type === "file") {
      out.type = "string";
      out.format = "binary";
    }
    if (node["x-nullable"] !== undefined) out.nullable = node["x-nullable"];
    if (node.collectionFormat && out.type === "array" && node.in === undefined) {
      // A header's or an item's collectionFormat has nowhere to go in 3.0.
      if (node.collectionFormat !== "csv") notes.add(collectionNote);
    }
    return out;
  };

  const collectionNote =
    "Some array parameters use a separator OpenAPI 3 can't express (tsv, or a non-comma separator on a header). They are sent comma-separated.";

  // Parameters

  /** `collectionFormat` as OpenAPI 3's `style`/`explode`. */
  const styleFor = (param: Json): Json => {
    if (param.type !== "array") return {};
    const format = param.collectionFormat ?? "csv";
    const where = param.in;
    if (format === "multi") return where === "query" || where === "formData" ? { style: "form", explode: true } : {};
    if (format === "csv") {
      if (where === "query" || where === "formData") return { style: "form", explode: false };
      return { style: "simple" };
    }
    if (format === "ssv" && where === "query") return { style: "spaceDelimited", explode: false };
    if (format === "pipes" && where === "query") return { style: "pipeDelimited", explode: false };
    notes.add(collectionNote);
    return {};
  };

  /** A non-body, non-form parameter as an OpenAPI 3 parameter. */
  const parameter = (param: Json): Json => ({
    ...pick(param, ["name", "in", "description", "required", "deprecated", "allowEmptyValue"]),
    ...(param.in === "path" ? { required: true } : {}),
    ...styleFor(param),
    schema: inlineSchema(param),
    ...(param["x-example"] !== undefined ? { example: param["x-example"] } : {}),
    ...extensions(param),
  });

  /** Follow a `#/parameters/…` reference to the shared parameter, if it is one. */
  const resolveParam = (param: Json): Json | undefined => {
    if (typeof param.$ref !== "string") return param;
    if (!param.$ref.startsWith("#/parameters/")) return undefined;
    return sharedParams[refName(param.$ref)];
  };

  // Media types

  /** The media types a response is offered in. */
  const producesFor = (op: Json): string[] => {
    const list: string[] = Array.isArray(op.produces) ? op.produces : globalProduces;
    return list.length ? list : ["application/json"];
  };

  /** The media types a JSON-ish body is sent as: everything declared except the form types. */
  const bodyTypes = (consumes: string[]): string[] => {
    const types = consumes.filter((type) => !FORM_TYPES.includes(type.toLowerCase()));
    return types.length ? types : ["application/json"];
  };

  /** A `body` parameter as a request body. */
  const bodyFromParam = (param: Json, consumes: string[]): Json => {
    const content: Json = {};
    const body = schema(param.schema ?? {});
    for (const type of bodyTypes(consumes)) {
      content[type] = { schema: body };
      if (param["x-examples"]?.[type] !== undefined) content[type].example = param["x-examples"][type];
    }
    return {
      ...pick(param, ["description"]),
      ...(param.required ? { required: true } : {}),
      content,
      ...extensions(param),
    };
  };

  /** `formData` parameters as one form request body. */
  const bodyFromForm = (fields: Json[], consumes: string[]): Json => {
    const declared = consumes.filter((type) => FORM_TYPES.includes(type.toLowerCase()));
    const hasFile = fields.some((field) => field.type === "file");
    if (!declared.length && consumes.length) {
      notes.add("Some form parameters are on operations that don't list a form media type; Studio sends them as a form.");
    }
    const types = declared.length ? declared : [hasFile ? "multipart/form-data" : "application/x-www-form-urlencoded"];
    const properties: Json = {};
    const required: string[] = [];
    const encoding: Json = {};
    for (const field of fields) {
      properties[field.name] = {
        ...inlineSchema(field),
        ...(field.description ? { description: field.description } : {}),
      };
      if (field.required) required.push(field.name);
      const style = styleFor(field);
      if (style.style) encoding[field.name] = style;
    }
    const formSchema: Json = { type: "object", properties, ...(required.length ? { required } : {}) };
    const content: Json = {};
    for (const type of types) {
      content[type] = {
        schema: formSchema,
        ...(Object.keys(encoding).length && type === "application/x-www-form-urlencoded" ? { encoding } : {}),
      };
    }
    return { ...(required.length ? { required: true } : {}), content };
  };

  // Responses

  const header = (node: Json): Json =>
    typeof node.$ref === "string"
      ? { $ref: rewriteRef(node.$ref) }
      : { ...pick(node, ["description"]), schema: inlineSchema(node), ...extensions(node) };

  const response = (node: Json, produces: string[]): Json => {
    if (typeof node.$ref === "string") return { $ref: rewriteRef(node.$ref) };
    const out: Json = { description: node.description ?? "", ...extensions(node) };
    if (isObject(node.headers)) {
      out.headers = Object.fromEntries(Object.entries<Json>(node.headers).map(([name, h]) => [name, header(h)]));
    }
    if (node.schema !== undefined) {
      const body = schema(node.schema);
      out.content = {};
      // An example given for a media type the operation doesn't list still
      // says the server sends that type, so it gets an entry of its own.
      const examples: Json = isObject(node.examples) ? node.examples : {};
      for (const type of [...new Set([...produces, ...Object.keys(examples)])]) {
        out.content[type] = { schema: body };
        if (examples[type] !== undefined) out.content[type].example = examples[type];
      }
    } else if (isObject(node.examples) && Object.keys(node.examples).length) {
      out.content = Object.fromEntries(
        Object.entries(node.examples).map(([type, example]) => [type, { example }]),
      );
    }
    return out;
  };

  // Operations

  const operation = (op: Json, pathBodies: Json[]): Json => {
    const consumes: string[] = Array.isArray(op.consumes) ? op.consumes : globalConsumes;
    const produces = producesFor(op);

    // Operation parameters override path-level ones with the same name and place.
    const own: Json[] = Array.isArray(op.parameters) ? op.parameters : [];
    const key = (p: Json) => {
      const resolved = resolveParam(p);
      return resolved ? `${resolved.in}:${resolved.name}` : String(p.$ref);
    };
    const ownKeys = new Set(own.map(key));
    const all = [...pathBodies.filter((p) => !ownKeys.has(key(p))), ...own];

    const parameters: Json[] = [];
    const formFields: Json[] = [];
    let requestBody: Json | undefined;
    for (const raw of all) {
      if (!isObject(raw)) continue;
      const param = resolveParam(raw);
      if (!param) {
        parameters.push({ $ref: rewriteRef(raw.$ref) });
        continue;
      }
      if (param.in === "body") {
        // A shared body parameter stays shared, as a request body component,
        // unless this operation takes other media types than the component has.
        requestBody =
          typeof raw.$ref === "string" && !Array.isArray(op.consumes)
            ? { $ref: rewriteRef(raw.$ref) }
            : bodyFromParam(param, consumes);
      } else if (param.in === "formData") {
        formFields.push(param);
      } else if (typeof raw.$ref === "string") {
        parameters.push({ $ref: rewriteRef(raw.$ref) });
      } else {
        parameters.push(parameter(param));
      }
    }
    if (formFields.length) {
      if (requestBody) notes.add("An operation declares both a body and form parameters; Studio kept the body.");
      else requestBody = bodyFromForm(formFields, consumes);
    }

    const responses: Json = {};
    for (const [status, def] of Object.entries<Json>(isObject(op.responses) ? op.responses : {})) {
      if (status.startsWith("x-")) responses[status] = def;
      else if (isObject(def)) responses[status] = response(def, produces);
    }

    const out: Json = {
      ...pick(op, ["tags", "summary", "description", "externalDocs", "operationId", "deprecated", "security"]),
      ...(parameters.length ? { parameters } : {}),
      ...(requestBody ? { requestBody } : {}),
      responses,
      ...extensions(op),
    };
    if (Array.isArray(op.schemes) && op.schemes.length) {
      const servers = serversFor(op.schemes);
      if (servers.length) out.servers = servers;
    }
    return out;
  };

  // Servers

  /** host + basePath + schemes as server URLs. */
  function serversFor(schemes: unknown): Json[] {
    const basePath = typeof source.basePath === "string" ? source.basePath.replace(/\/$/, "") : "";
    if (typeof source.host !== "string" || !source.host) {
      // No host means "the host this document is served from". A spec opened
      // from a URL resolves that later; from a file it stays relative.
      return [{ url: basePath || "/" }];
    }
    let list = Array.isArray(schemes) ? schemes.filter((s) => typeof s === "string") : [];
    if (!list.length) {
      // No schemes means "the scheme this document was fetched with".
      const fetched = options.documentUrl?.match(/^(https?):/i)?.[1]?.toLowerCase();
      if (fetched) list = [fetched];
      else {
        list = ["https"];
        notes.add("The spec doesn't list schemes, so Studio assumed https.");
      }
    }
    // https first: the safer choice is the one Studio selects by default.
    const ordered = [...list].sort((a, b) => Number(b === "https") - Number(a === "https"));
    return ordered.map((scheme) => ({ url: `${scheme}://${source.host}${basePath}` }));
  }

  // Document

  const paths: Json = {};
  for (const [path, item] of Object.entries<Json>(isObject(source.paths) ? source.paths : {})) {
    if (path.startsWith("x-")) {
      paths[path] = item;
      continue;
    }
    if (!isObject(item)) continue;
    if (typeof item.$ref === "string") {
      notes.add("Some paths are references to other files; Studio doesn't follow them.");
      paths[path] = { $ref: item.$ref };
      continue;
    }
    const pathParams: Json[] = Array.isArray(item.parameters) ? item.parameters.filter(isObject) : [];
    const out: Json = { ...extensions(item) };
    // Body and form parameters declared for the whole path move into each
    // operation's request body; ordinary ones stay at path level (below).
    const pathBodies = pathParams.filter((raw) => {
      const param = resolveParam(raw);
      return param?.in === "body" || param?.in === "formData";
    });
    for (const method of HTTP_METHODS) {
      if (isObject(item[method])) out[method] = operation(item[method], pathBodies);
    }
    const shared = pathParams
      .map((raw) => ({ raw, param: resolveParam(raw) }))
      .filter(({ param }) => param && param.in !== "body" && param.in !== "formData");
    if (shared.length) {
      out.parameters = shared.map(({ raw, param }) =>
        typeof raw.$ref === "string" ? { $ref: rewriteRef(raw.$ref) } : parameter(param!),
      );
    }
    paths[path] = out;
  }

  const components: Json = {};
  if (isObject(source.definitions)) {
    components.schemas = Object.fromEntries(
      Object.entries(source.definitions).map(([name, def]) => [name, schema(def)]),
    );
  }
  const parameters: Json = {};
  const requestBodies: Json = {};
  for (const [name, param] of Object.entries<Json>(sharedParams)) {
    if (!isObject(param)) continue;
    if (param.in === "body") requestBodies[name] = bodyFromParam(param, globalConsumes);
    // Shared form fields have no component of their own in 3.0; operations
    // that use them get them inlined into their request body.
    else if (param.in !== "formData") parameters[name] = parameter(param);
  }
  if (Object.keys(parameters).length) components.parameters = parameters;
  if (Object.keys(requestBodies).length) components.requestBodies = requestBodies;
  if (isObject(source.responses)) {
    components.responses = Object.fromEntries(
      Object.entries<Json>(source.responses)
        .filter(([, def]) => isObject(def))
        .map(([name, def]) => [name, response(def, globalProduces.length ? globalProduces : ["application/json"])]),
    );
  }
  if (isObject(source.securityDefinitions)) {
    components.securitySchemes = Object.fromEntries(
      Object.entries<Json>(source.securityDefinitions)
        .filter(([, def]) => isObject(def))
        .map(([name, def]) => [name, securityScheme(def)]),
    );
  }

  const doc: Json = {
    openapi: "3.0.3",
    info: isObject(source.info) ? source.info : { title: "", version: "" },
    servers: serversFor(source.schemes),
    ...pick(source, ["security", "tags", "externalDocs"]),
    paths,
    ...(Object.keys(components).length ? { components } : {}),
    ...extensions(source),
  };
  return { doc, notes: [...notes] };
}

/** A Swagger 2.0 security definition as an OpenAPI 3 security scheme. */
function securityScheme(def: Json): Json {
  const base = { ...pick(def, ["description"]), ...extensions(def) };
  if (def.type === "basic") return { type: "http", scheme: "basic", ...base };
  if (def.type === "apiKey") return { type: "apiKey", name: def.name, in: def.in, ...base };
  if (def.type === "oauth2") {
    const scopes = isObject(def.scopes) ? def.scopes : {};
    const flow = def.flow;
    const flows: Json = {};
    if (flow === "implicit") flows.implicit = { authorizationUrl: def.authorizationUrl, scopes };
    else if (flow === "password") flows.password = { tokenUrl: def.tokenUrl, scopes };
    else if (flow === "application") flows.clientCredentials = { tokenUrl: def.tokenUrl, scopes };
    else if (flow === "accessCode") {
      flows.authorizationCode = { authorizationUrl: def.authorizationUrl, tokenUrl: def.tokenUrl, scopes };
    }
    return { type: "oauth2", flows, ...base };
  }
  return { ...def };
}

/** The short note shown wherever a converted API is on screen. */
export const CONVERTED_LABEL = "Converted from Swagger 2.0 when opened";

/**
 * The longer explanation: what the conversion means for what you see, and
 * where it may be imperfect. Kept next to the converter so the wording can't
 * drift from what it actually does.
 */
export function describeConversion(notes: readonly string[]): string {
  return [
    "Studio converted this Swagger 2.0 file to OpenAPI 3.0 when it opened it. The Raw tab shows the file as imported; operations, schemas, checks and the Reference tab use the conversion.",
    "The conversion covers what Swagger 2.0 specs commonly use. If something looks wrong, compare it with the Raw tab.",
    ...notes,
  ].join(" ");
}
