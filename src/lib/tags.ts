/** Words that stay in capitals when a tag is turned into a label. */
const ACRONYMS = new Set(["api", "apis", "rag", "mcp", "id", "ids", "url", "urls", "http", "https", "sdk", "ui", "oauth", "json", "xml", "csv", "pdf", "ai"]);

/**
 * An OpenAPI tag as a group label: `api-discovery-rag-controller` becomes
 * "API discovery RAG". Splits on `-`, `_` and camel case, drops a trailing
 * "controller" (a framework's name for a class, not a part of the API), and
 * uses sentence case. A tag that already reads as words ("Payments", "Order
 * history") is left as written.
 */
export function tagLabel(tag: string): string {
  const looksLikeWords = /\s/.test(tag) && !/[-_]/.test(tag);
  if (looksLikeWords) return tag;
  const words = tag
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  if (words.length > 1 && words[words.length - 1] === "controller") words.pop();
  if (!words.length) return tag;
  return words
    .map((word, index) => {
      if (ACRONYMS.has(word)) return word === "apis" ? "APIs" : word === "ids" ? "IDs" : word === "urls" ? "URLs" : word === "oauth" ? "OAuth" : word.toUpperCase();
      return index === 0 ? word[0].toUpperCase() + word.slice(1) : word;
    })
    .join(" ");
}
