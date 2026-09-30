import { load } from "js-yaml";

/**
 * What kind of collection a file holds, before Studio tries to read it.
 *
 * Studio imports its own collection files and Postman collections (v2.1, and
 * v2.0, which is close enough to read the same way). Anything else gets a
 * message that says what the file is and what to do instead, rather than a
 * parse error about a field it was never going to have.
 */
export type ImportFormat =
  | { kind: "studio" }
  | { kind: "postman"; version: "2.0" | "2.1"; data: Record<string, unknown> }
  | { kind: "unsupported"; message: string };

const SUPPORTED =
  "Studio imports its own collection files (.spec0-collection.yaml) and Postman collections exported as v2.1 JSON.";

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON; YAML is the other format anyone would hand us.
  }
  try {
    return load(text);
  } catch {
    return undefined;
  }
}

export function detectImportFormat(text: string): ImportFormat {
  // Bruno's own files aren't JSON or YAML at all.
  if (/^\s*meta\s*\{/m.test(text) && /^\s*(get|post|put|patch|delete|head|options)\s*\{/m.test(text)) {
    return {
      kind: "unsupported",
      message: `This looks like a Bruno request file. Bruno collections can't be imported yet. ${SUPPORTED}`,
    };
  }
  const raw = parse(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    // Let the collection parser say what's wrong with it: it's the only
    // format left, and its messages are specific.
    return { kind: "studio" };
  }
  const data = raw as Record<string, unknown>;
  const info = data.info && typeof data.info === "object" ? (data.info as Record<string, unknown>) : null;
  const schema = typeof info?.schema === "string" ? info.schema : "";

  if (/collection\/v2\.1/.test(schema)) return { kind: "postman", version: "2.1", data };
  if (/collection\/v2\.0/.test(schema)) return { kind: "postman", version: "2.0", data };
  if (/getpostman\.com|postman/i.test(schema)) {
    return {
      kind: "unsupported",
      message: `This Postman collection uses a format Studio doesn't read (${schema}). In Postman, export it as Collection v2.1 and import that file.`,
    };
  }
  if (info && Array.isArray(data.item)) return { kind: "postman", version: "2.1", data };
  if (Array.isArray(data.requests) && (Array.isArray(data.order) || Array.isArray(data.folders))) {
    return {
      kind: "unsupported",
      message: "This is a Postman collection in the old v1 format. In Postman, export it again as Collection v2.1 and import that file.",
    };
  }
  if (Array.isArray(data.values) && ("_postman_variable_scope" in data || "_postman_exported_using" in data)) {
    return {
      kind: "unsupported",
      message: "This is a Postman environment, not a collection. Import the collection; its variables can become a Studio environment.",
    };
  }
  if (
    data._type === "export" ||
    "__export_format" in data ||
    (typeof data.type === "string" && /insomnia/i.test(data.type))
  ) {
    return { kind: "unsupported", message: `This is an Insomnia export. Insomnia collections can't be imported yet. ${SUPPORTED}` };
  }
  if ("brunoConfig" in data || (Array.isArray(data.items) && typeof data.name === "string" && "version" in data && !("steps" in data))) {
    return { kind: "unsupported", message: `This looks like a Bruno collection. Bruno collections can't be imported yet. ${SUPPORTED}` };
  }
  if ("openapi" in data || "swagger" in data) {
    return {
      kind: "unsupported",
      message: "This is an API spec, not a collection. Add it from the APIs tab; then its operations can be steps.",
    };
  }
  if (data.log && typeof data.log === "object" && Array.isArray((data.log as Record<string, unknown>).entries)) {
    return { kind: "unsupported", message: `This is a HAR file (recorded browser traffic). It can't be imported as a collection. ${SUPPORTED}` };
  }
  if (typeof data.version === "number") return { kind: "studio" };
  return { kind: "unsupported", message: `Studio can't tell what this file is. ${SUPPORTED}` };
}
