/**
 * A small Markdown reader for what agents write in the chat panel: headings,
 * paragraphs, lists, quotes, code blocks, inline code, bold, italics and links.
 *
 * It produces plain data that the panel turns into React elements. Nothing is
 * ever turned into HTML, so a message can't inject markup or load anything:
 * images are shown as their text, and only http(s) links are links at all.
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] };

export type Block =
  | { type: "heading"; level: number; children: Inline[] }
  | { type: "paragraph"; children: Inline[] }
  | { type: "code"; lang: string; text: string }
  | { type: "list"; ordered: boolean; items: Inline[][] }
  | { type: "quote"; children: Inline[] }
  | { type: "rule" };

/** Only web links open, and only in the browser. Anything else stays text. */
export function safeHref(href: string): string | null {
  try {
    const url = new URL(href.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

const LIST_ITEM = /^\s{0,3}(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)/;

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length) blocks.push({ type: "paragraph", children: parseInline(paragraph.join("\n")) });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const marker = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(marker)) body.push(lines[i++]);
      blocks.push({ type: "code", lang: fence[2] ?? "", text: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: "heading", level: heading[1].length, children: parseInline(heading[2]) });
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push({ type: "rule" });
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      flush();
      const quoted: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) quoted.push(lines[i++].replace(/^\s{0,3}>\s?/, ""));
      i--;
      blocks.push({ type: "quote", children: parseInline(quoted.join("\n")) });
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      flush();
      const ordered = item[2] !== undefined;
      const items: string[] = [];
      while (i < lines.length) {
        const next = LIST_ITEM.exec(lines[i]);
        if (next && (next[2] !== undefined) === ordered) items.push(next[3]);
        else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) items[items.length - 1] += `\n${lines[i].trim()}`;
        else break;
        i++;
      }
      i--;
      blocks.push({ type: "list", ordered, items: items.map(parseInline) });
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

// Sticky patterns, matched where the reader is rather than on a copy of the rest.
const CODE = /(`+)([\s\S]*?[^`])\1(?!`)/y;
const IMAGE = /!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/y;
const LINK = /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/y;
const BARE = /https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/y;
const STRONG = /(\*\*|__)(?=\S)([\s\S]*?\S)\1/y;
const EM = /(\*|_)(?=\S)([\s\S]*?\S)\1(?![*_\w])/y;
/** Characters that can start formatting. Anything else is plain text, read in one go. */
const SPECIAL = /[`!\[h*_]/g;

function at(pattern: RegExp, text: string, index: number): RegExpExecArray | null {
  pattern.lastIndex = index;
  return pattern.exec(text);
}

/** Inline formatting. Unmatched markers are kept as the characters they are. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let plain = "";
  const push = (node: Inline) => {
    if (plain) out.push({ type: "text", text: plain });
    plain = "";
    out.push(node);
  };

  let i = 0;
  while (i < text.length) {
    SPECIAL.lastIndex = i;
    const next = SPECIAL.exec(text);
    if (!next) {
      plain += text.slice(i);
      break;
    }
    if (next.index > i) {
      plain += text.slice(i, next.index);
      i = next.index;
    }

    const code = at(CODE, text, i);
    if (code) {
      push({ type: "code", text: code[2].trim() || code[2] });
      i += code[0].length;
      continue;
    }

    // An image is shown as its description: nothing is loaded.
    const image = at(IMAGE, text, i);
    if (image) {
      plain += image[1] ? `[image: ${image[1]}]` : "[image]";
      i += image[0].length;
      continue;
    }

    const link = at(LINK, text, i);
    if (link) {
      const href = safeHref(link[2]);
      if (href) push({ type: "link", href, children: parseInline(link[1]) });
      else plain += link[1];
      i += link[0].length;
      continue;
    }

    const bare = i === 0 || /[\s(]/.test(text[i - 1]) ? at(BARE, text, i) : null;
    const bareHref = bare ? safeHref(bare[0]) : null;
    if (bare && bareHref) {
      push({ type: "link", href: bareHref, children: [{ type: "text", text: bare[0] }] });
      i += bare[0].length;
      continue;
    }

    const strong = at(STRONG, text, i);
    if (strong) {
      push({ type: "strong", children: parseInline(strong[2]) });
      i += strong[0].length;
      continue;
    }

    const em = i === 0 || !/\w/.test(text[i - 1]) ? at(EM, text, i) : null;
    if (em) {
      push({ type: "em", children: parseInline(em[2]) });
      i += em[0].length;
      continue;
    }

    plain += text[i];
    i++;
  }
  if (plain) out.push({ type: "text", text: plain });
  return out;
}
