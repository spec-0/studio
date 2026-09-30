import { exampleBody, exampleParam } from "./example";
import type { MultipartPart } from "./request";
import { bodyFieldNames, type OperationSpec, type ParsedSpec } from "./spec";

/**
 * Everything the operation editor holds, as plain data: what it starts from,
 * and what a draft of it keeps.
 *
 * No React here. The editor itself is `src/components/OperationView.tsx`; the
 * drafts that remember its fields between visits are in `drafts.ts`.
 */

/** The editor's fields, exactly as they are on screen. */
export interface EditorState {
  pathParams: Record<string, string>;
  queryParams: Record<string, string>;
  /** Header parameters the operation declares (and, for a copied request, the headers it had). */
  headerParams: Record<string, string>;
  /** The raw body text, for an operation that takes text or JSON. */
  body: string;
  formFields: Array<{ key: string; value: string }>;
  parts: MultipartPart[];
  /** Headers typed by hand, as rows. */
  custom: Array<{ key: string; value: string }>;
}

/** Values to start from instead of generated examples, such as a copied recording. */
export interface EditorPrefill {
  headers: Record<string, string>;
  body?: string;
  pathParams?: Record<string, string>;
  queryParams?: Record<string, string>;
  /** Form fields or multipart parts, for an operation that takes them. */
  form?: Array<{ key: string; value: string }>;
  parts?: MultipartPart[];
}

/**
 * What every input starts from: the prefill where there is one, the spec's
 * examples otherwise.
 *
 * `split` is for a collection step: prefilled headers the operation doesn't
 * declare become editable rows instead of being sent unseen.
 */
export function seedEditor(
  spec: ParsedSpec,
  op: OperationSpec,
  prefill: EditorPrefill | null | undefined,
  split: boolean,
): EditorState {
  const seed = (where: string) =>
    Object.fromEntries(
      op.parameters
        .filter((p) => p.in === where)
        .map((p) => [p.name, p.required ? exampleParam(spec.doc, p.schema, p.name) : ""]),
    );
  let headerParams = prefill?.headers ?? seed("header");
  const custom: Array<{ key: string; value: string }> = [];
  if (prefill && split) {
    const declared = op.parameters.filter((p) => p.in === "header").map((p) => p.name);
    headerParams = Object.fromEntries(declared.map((name) => [name, ""]));
    for (const [key, value] of Object.entries(prefill.headers)) {
      const match = declared.find((name) => name.toLowerCase() === key.toLowerCase());
      if (match) headerParams[match] = value;
      else custom.push({ key, value });
    }
  }
  // Form fields and multipart parts start from the names the schema declares,
  // so an upload endpoint opens with its parts already listed.
  const declaredFields = bodyFieldNames(spec.doc, op.requestBody?.schema);
  return {
    // A copied recording supplies the values that were actually sent; only fall
    // back to generated examples when there is nothing to start from.
    pathParams: prefill?.pathParams ?? seed("path"),
    queryParams: prefill?.queryParams ?? seed("query"),
    headerParams,
    body: prefill?.body ?? (op.requestBody ? exampleBody(spec.doc, op.requestBody.schema, op.requestBody.media) : ""),
    formFields: prefill?.form ?? declaredFields.map((name) => ({ key: name, value: "" })),
    parts: prefill?.parts ?? declaredFields.map((name) => ({ name, value: "" })),
    custom,
  };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as object)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** A string that is equal for two editors holding the same values, whatever the key order. */
export function editorFingerprint(state: EditorState): string {
  return stable(state);
}

export function sameEditor(a: EditorState, b: EditorState): boolean {
  return editorFingerprint(a) === editorFingerprint(b);
}
