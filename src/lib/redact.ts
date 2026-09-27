import type { Environment } from "./env";

/**
 * Keeping secret values out of what Studio records or reports: request
 * history, error messages, and the exported conformance report.
 *
 * Redaction is by value, not by variable: by the time a request is recorded the
 * `{{token}}` has been filled in, so the only way to find it is to know what it
 * was. The environments module registers the values whenever it loads or saves.
 */

let pattern: RegExp | null = null;
let replacements = new Map<string, string>();

/**
 * Tell redaction which values are secret. Called whenever environments load or
 * save, with every environment — not only the active one, since a request can
 * carry a value copied from another.
 */
export function setKnownSecrets(environments: Environment[]): void {
  const next = new Map<string, string>();
  for (const env of environments) {
    for (const variable of env.variables) {
      if (!variable.secret || !variable.value || !variable.name) continue;
      const placeholder = `{{${variable.name}}}`;
      const forms = [
        variable.value,
        // As it appears in a URL query or a form body.
        encodeURIComponent(variable.value),
        new URLSearchParams({ v: variable.value }).toString().slice(2),
      ];
      for (const form of forms) if (form && !next.has(form)) next.set(form, placeholder);
    }
  }
  replacements = next;
  const escaped = [...next.keys()]
    .sort((a, b) => b.length - a.length) // longest first, so a value inside another can't split it
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  pattern = escaped.length ? new RegExp(escaped.join("|"), "g") : null;
}

/**
 * Replace every secret value with its `{{name}}` reference.
 *
 * The reference rather than a row of dots: it says which secret was there, and a
 * request copied from history resolves it again from the environment.
 */
export function redact(text: string): string;
export function redact(text: string | undefined): string | undefined;
export function redact(text: string | undefined): string | undefined {
  if (!text || !pattern) return text;
  return text.replace(pattern, (match) => replacements.get(match) ?? match);
}

/** Headers, including a Basic credential whose secret is base64-encoded. */
export function redactHeaders(headers: Record<string, string>): Record<string, string>;
export function redactHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined;
export function redactHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers || !pattern) return headers;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    let next = redact(value);
    const basic = /^basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(value);
    if (basic && next === value) {
      try {
        const decoded = atob(basic[1]);
        const hidden = redact(decoded);
        if (hidden !== decoded) next = `Basic ${hidden}`;
      } catch {
        // Not base64 after all; nothing to decode.
      }
    }
    out[key] = next;
  }
  return out;
}
