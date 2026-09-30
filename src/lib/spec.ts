import { dump, load } from "js-yaml";
import { convertSwagger2, isSwagger2 } from "./swagger2";

/**
 * Parse an OpenAPI document into the shape the UI consumes.
 *
 * Deliberately does NOT dereference the whole document up front: Stripe-scale
 * specs (~6MB, deeply nested, cyclic) make full dereferencing expensive and
 * stack-hostile. `$ref`s are kept intact and resolved on demand by `deref`,
 * which carries a seen-set so cycles terminate.
 */

export type Json = Record<string, any>;

export interface ParamSpec {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required: boolean;
  schema: Json;
  description?: string;
}

export interface ResponseSpec {
  status: string;
  description?: string;
  contentType?: string;
  schema?: Json;
}

export interface OperationSpec {
  id: string;
  method: string;
  path: string;
  operationId?: string;
  summary?: string;
  description?: string;
  tag: string;
  deprecated: boolean;
  parameters: ParamSpec[];
  /** `media` is the chosen media type object as written, for its `example`/`examples`. */
  requestBody?: { required: boolean; contentType: string; schema?: Json; media?: Json };
  responses: ResponseSpec[];
  security?: string[];
}

export interface SchemaEntry {
  name: string;
  schema: Json;
  /** How many operations mention this schema anywhere in their subtree. */
  usedIn: number;
}

/** One OAuth 2.0 flow the document declares, flattened to what a client needs. */
export interface OAuthFlowSpec {
  /** `clientCredentials` | `authorizationCode` | `implicit` | `password`, as written. */
  kind: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  refreshUrl?: string;
  /** Scope name → its description, in declaration order. */
  scopes: Array<{ name: string; description: string }>;
}

export interface SecuritySchemeSpec {
  name: string;
  type: string;
  scheme?: string;
  in?: string;
  paramName?: string;
  description?: string;
  /**
   * Declared `oauth2` flows.
   *
   * Parsed so a client can pre-fill token and authorization URLs and offer the
   * scopes the API actually defines. Asking someone to retype a URL the
   * document already states is exactly what a spec-native client shouldn't do.
   */
  flows?: OAuthFlowSpec[];
}

export interface ParsedSpec {
  title: string;
  version: string;
  description?: string;
  servers: string[];
  operations: OperationSpec[];
  schemas: SchemaEntry[];
  securitySchemes: SecuritySchemeSpec[];
  tags: string[];
  /** The document Studio works from: OpenAPI 3, converted if the file was Swagger 2.0. */
  doc: Json;
  /** The text as imported. For a converted spec, that is the Swagger 2.0 original. */
  sourceText: string;
  sourceName: string;
  /** Present when the file was Swagger 2.0 and `doc` is Studio's conversion of it. */
  converted?: ConvertedSpec;
}

export interface ConvertedSpec {
  from: "Swagger 2.0";
  /** Where the conversion had to guess or drop something; empty when it didn't. */
  notes: string[];
}

const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "options", "head", "trace"];

/** OpenAPI's `flows` object → a flat list. Absent or malformed yields undefined. */
function parseOAuthFlows(flows: Json | undefined): OAuthFlowSpec[] | undefined {
  if (!flows || typeof flows !== "object" || Array.isArray(flows)) return undefined;
  const parsed = Object.entries<Json>(flows)
    .filter(([, flow]) => flow && typeof flow === "object")
    .map(([kind, flow]) => ({
      kind,
      authorizationUrl: typeof flow.authorizationUrl === "string" ? flow.authorizationUrl : undefined,
      tokenUrl: typeof flow.tokenUrl === "string" ? flow.tokenUrl : undefined,
      refreshUrl: typeof flow.refreshUrl === "string" ? flow.refreshUrl : undefined,
      scopes: Object.entries<string>(
        flow.scopes && typeof flow.scopes === "object" ? flow.scopes : {},
      ).map(([name, description]) => ({ name, description: String(description ?? "") })),
    }));
  return parsed.length ? parsed : undefined;
}

/**
 * If Studio can't convert a Swagger 2.0 document, converting it locally is a
 * one-liner, so the error says how. The Library screen offers to copy it.
 */
export const SWAGGER2_CONVERT_COMMAND = "npx swagger2openapi <file> -o openapi.json";

/** A parsed document, and whether Studio converted it from Swagger 2.0 to get there. */
export interface ReadDocument {
  doc: Json;
  converted?: ConvertedSpec;
}

/**
 * Parse a document's text into the OpenAPI 3 document Studio works from.
 *
 * Swagger 2.0 is converted here, so everything downstream only ever sees
 * OpenAPI 3. The caller keeps the original text.
 */
export function readDocument(text: string, documentUrl?: string): ReadDocument {
  const trimmed = text.trimStart();
  const doc = trimmed.startsWith("{") ? JSON.parse(text) : (load(text) as Json);
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error("The OpenAPI document's root must be an object.");
  }
  if (!doc.openapi && !doc.swagger) {
    throw new Error("No `openapi` or `swagger` version field. Is this an OpenAPI document?");
  }
  if (!isSwagger2(doc)) return { doc };
  try {
    const { doc: converted, notes } = convertSwagger2(doc, { documentUrl });
    return { doc: converted, converted: { from: "Swagger 2.0", notes } };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Studio couldn't convert this Swagger 2.0 document to OpenAPI 3: ${reason} ` +
        `You can convert it on your machine instead, then open the result: ${SWAGGER2_CONVERT_COMMAND}`,
    );
  }
}

export function parseDocument(text: string, documentUrl?: string): Json {
  return readDocument(text, documentUrl).doc;
}

const convertedTexts = new WeakMap<ParsedSpec, string>();

/**
 * The document as OpenAPI 3 text: the imported text, or for a converted spec,
 * the conversion written out in the same format as the file (JSON or YAML).
 *
 * What the Reference tab renders and what publishing sends, so both describe
 * the document the rest of Studio uses. Written out on first use and cached,
 * since most sessions never need it.
 */
export function openapiText(spec: ParsedSpec): string {
  if (!spec.converted) return spec.sourceText;
  let text = convertedTexts.get(spec);
  if (text === undefined) {
    text = spec.sourceText.trimStart().startsWith("{")
      ? JSON.stringify(spec.doc, null, 2)
      : dump(spec.doc, { noRefs: true, lineWidth: -1 });
    convertedTexts.set(spec, text);
  }
  return text;
}

/** Resolve one `$ref` against the document root. Returns undefined if unresolvable. */
export function resolveRef(doc: Json, ref: string): Json | undefined {
  if (!ref.startsWith("#/")) return undefined; // remote/file refs are out of scope for now
  let node: any = doc;
  for (const rawPart of ref.slice(2).split("/")) {
    const part = rawPart.replace(/~1/g, "/").replace(/~0/g, "~");
    if (node == null || typeof node !== "object") return undefined;
    node = node[part];
  }
  return node;
}

/**
 * Resolve `$ref` one level at a time, with a seen-set so `User → Post → User`
 * terminates instead of recursing forever. A schema whose ref was already
 * expanded on this path comes back marked `x-circular` for the UI to render.
 */
export function deref(doc: Json, schema: Json | undefined, seen = new Set<string>()): Json {
  if (!schema || typeof schema !== "object") return schema ?? {};
  if (typeof schema.$ref === "string") {
    if (seen.has(schema.$ref)) return { "x-circular": schema.$ref };
    const next = new Set(seen).add(schema.$ref);
    const target = resolveRef(doc, schema.$ref);
    if (!target) return { "x-unresolved": schema.$ref };
    return deref(doc, target, next);
  }
  return schema;
}

/** The display name of a schema node: `Order`, `Order[]`, `string (email)`, … */
export function typeLabel(doc: Json, schema: Json | undefined): string {
  if (!schema) return "any";
  if (typeof schema.$ref === "string") return schema.$ref.split("/").pop() ?? "ref";
  if (schema.allOf) return schema.allOf.map((s: Json) => typeLabel(doc, s)).join(" & ");
  if (schema.oneOf) return schema.oneOf.map((s: Json) => typeLabel(doc, s)).join(" | ");
  if (schema.anyOf) return schema.anyOf.map((s: Json) => typeLabel(doc, s)).join(" | ");
  if (schema.enum) return `enum(${schema.enum.slice(0, 3).join(", ")}${schema.enum.length > 3 ? "…" : ""})`;
  if (schema.type === "array") return `${typeLabel(doc, schema.items)}[]`;
  if (schema.format) return `${schema.type ?? "string"} (${schema.format})`;
  return schema.type ?? "object";
}

function pickContent(content: Json | undefined): { contentType: string; schema?: Json; media?: Json } | undefined {
  if (!content) return undefined;
  // JSON first where it's offered, since that's what the generated example
  // targets. But an endpoint that only takes multipart must report multipart,
  // or the editor offers a JSON box for a file upload.
  const preferred = Object.keys(content).find((k) => k.includes("json")) ?? Object.keys(content)[0];
  if (!preferred) return undefined;
  return { contentType: preferred, schema: content[preferred]?.schema, media: content[preferred] };
}

/** Which editor a declared content type calls for. */
export function bodyModeFor(contentType: string | undefined): "text" | "form" | "multipart" {
  const lowered = (contentType ?? "").toLowerCase();
  if (lowered.includes("multipart/form-data")) return "multipart";
  if (lowered.includes("x-www-form-urlencoded")) return "form";
  return "text";
}

/** Part or field names the schema declares, so the editor can seed them. */
export function bodyFieldNames(doc: Json, schema: Json | undefined): string[] {
  if (!schema) return [];
  const resolved = deref(doc, schema);
  const properties = resolved?.properties;
  return properties && typeof properties === "object" ? Object.keys(properties) : [];
}

/** Every `$ref` target name appearing anywhere in a subtree. */
function refNames(node: unknown, out = new Set<string>()): Set<string> {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) refNames(item, out);
    return out;
  }
  for (const [key, value] of Object.entries(node as Json)) {
    if (key === "$ref" && typeof value === "string" && value.startsWith("#/components/schemas/")) {
      out.add(value.slice("#/components/schemas/".length));
    } else {
      refNames(value, out);
    }
  }
  return out;
}

/**
 * Turn the spec's server URLs into full URLs.
 *
 * OpenAPI allows a server URL like `/api/v3`, which means "relative to where
 * this document is served". When the spec was opened from a URL, that is
 * something Studio can resolve. A relative server in a local file has nothing
 * to resolve against, so it is left as written and the address bar says so.
 */
export function resolveServers(servers: string[], documentUrl?: string): string[] {
  if (!documentUrl) return servers;
  return servers.map((url) => {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) || url.includes("{")) return url;
    try {
      return new URL(url, documentUrl).toString().replace(/\/$/, "");
    } catch {
      return url;
    }
  });
}

export function parseSpec(text: string, sourceName: string, documentUrl?: string): ParsedSpec {
  const { doc, converted } = readDocument(text, documentUrl);

  const operations: OperationSpec[] = [];
  for (const [path, pathItem] of Object.entries<Json>(doc.paths ?? {})) {
    if (!pathItem || typeof pathItem !== "object") continue;
    const sharedParams: Json[] = pathItem.parameters ?? [];
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op || typeof op !== "object") continue;

      const params = [...sharedParams, ...(op.parameters ?? [])]
        .map((p: Json) => deref(doc, p))
        .filter((p: Json) => p && p.name)
        .map((p: Json) => ({
          name: p.name,
          in: p.in,
          required: p.in === "path" ? true : Boolean(p.required),
          schema: p.schema ?? { type: "string" },
          description: p.description,
        })) as ParamSpec[];

      const bodyDef = deref(doc, op.requestBody);
      const bodyContent = pickContent(bodyDef?.content);

      const responses: ResponseSpec[] = Object.entries<Json>(op.responses ?? {}).map(
        ([status, def]) => {
          const resolved = deref(doc, def);
          const content = pickContent(resolved?.content);
          return {
            status,
            description: resolved?.description,
            contentType: content?.contentType,
            schema: content?.schema,
          };
        },
      );

      operations.push({
        id: `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase(),
        path,
        operationId: op.operationId,
        summary: op.summary,
        description: op.description,
        tag: op.tags?.[0] ?? "default",
        deprecated: Boolean(op.deprecated),
        parameters: params,
        requestBody: bodyContent
          ? {
              required: Boolean(bodyDef?.required),
              contentType: bodyContent.contentType,
              schema: bodyContent.schema,
              media: bodyContent.media,
            }
          : undefined,
        responses,
        security: (op.security ?? doc.security)?.flatMap((s: Json) => Object.keys(s)),
      });
    }
  }

  // Usage counts drive the schema list's "used in N operations" column.
  const usage = new Map<string, number>();
  for (const op of operations) {
    const opNode = doc.paths?.[op.path]?.[op.method.toLowerCase()];
    for (const name of refNames(opNode)) usage.set(name, (usage.get(name) ?? 0) + 1);
  }

  const schemas: SchemaEntry[] = Object.entries<Json>(doc.components?.schemas ?? {})
    .map(([name, schema]) => ({ name, schema, usedIn: usage.get(name) ?? 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const securitySchemes: SecuritySchemeSpec[] = Object.entries<Json>(
    doc.components?.securitySchemes ?? {},
  ).map(([name, def]) => ({
    name,
    type: def.type,
    scheme: def.scheme,
    in: def.in,
    paramName: def.name,
    description: def.description,
    flows: parseOAuthFlows(def.flows),
  }));

  const tags = [...new Set(operations.map((o) => o.tag))].sort();

  return {
    title: doc.info?.title ?? sourceName,
    version: doc.info?.version ?? "",
    description: doc.info?.description,
    servers: resolveServers((doc.servers ?? []).map((s: Json) => s.url).filter(Boolean), documentUrl),
    operations,
    schemas,
    securitySchemes,
    tags,
    doc,
    sourceText: text,
    sourceName,
    ...(converted ? { converted } : {}),
  };
}
