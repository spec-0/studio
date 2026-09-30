import { CORE_SCHEMA, load, loadAll, mergeTag } from "js-yaml";

/**
 * YAML 1.2 core schema plus `<<` merge keys. Real specs use merge keys to
 * share parameters and headers, and js-yaml 5 leaves them out by default.
 * Timestamps stay strings, which is what an OpenAPI document means by them.
 */
const SCHEMA = CORE_SCHEMA.withTags(mergeTag);

/**
 * Parse one YAML document. An empty or comment-only document is `undefined`,
 * so callers report it as "not an object" like any other wrong shape instead
 * of as a parse error.
 */
export function loadYaml(text: string): unknown {
  try {
    return load(text, { schema: SCHEMA });
  } catch (error) {
    if (isEmpty(text)) return undefined;
    throw error;
  }
}

function isEmpty(text: string): boolean {
  try {
    return loadAll(text, null, { schema: SCHEMA }).length === 0;
  } catch {
    return false;
  }
}
