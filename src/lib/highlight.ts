/**
 * A very small YAML/JSON tokenizer for the Raw tab.
 *
 * Deliberately not shiki/prism. The Raw tab shows one kind of document
 * (an OpenAPI spec, in one of two syntaxes), and a general-purpose highlighter
 * brings a grammar engine and a theme system to a job that needs neither.
 * Studio already carries one large rendering dependency for the Reference tab;
 * a second one to colour keys and strings would be the larger cost of the two.
 *
 * The contract that keeps this honest is {@link tokenize} being lossless:
 * concatenating every token's text reproduces the input exactly. Highlighting
 * that silently eats a character is worse than no highlighting, because the
 * document on screen would no longer be the document on disk, and the whole
 * point of Raw is that it is.
 */

export type TokenKind =
  | "plain"
  | "key"
  | "string"
  | "number"
  | "literal"
  | "comment"
  | "punct"
  | "anchor";

export interface Token {
  kind: TokenKind;
  text: string;
}

export type Syntax = "json" | "yaml";

/** JSON if it opens like JSON, YAML otherwise. Mirrors how the parser decides. */
export function detectSyntax(text: string): Syntax {
  const head = text.trimStart();
  return head.startsWith("{") || head.startsWith("[") ? "json" : "yaml";
}

const NUMBER = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const LITERALS = new Set(["true", "false", "null", "~", "True", "False", "Null", "None"]);

/**
 * Which lines fall inside a YAML block scalar (`|`, `>`).
 *
 * Computed for the whole document in one linear pass that allocates nothing per
 * line, because the Raw view highlights only the lines currently on screen and
 * still needs to know whether line 40,000 is prose or structure. Tokenizing a
 * 7.6MB spec to draw forty lines of it is the thing this exists to avoid.
 */
export function blockScalarMask(lines: string[], syntax: Syntax): Uint8Array {
  const mask = new Uint8Array(lines.length);
  if (syntax !== "yaml") return mask;

  let blockIndent: number | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;
    const blank = trimmed === "";

    if (blockIndent !== null) {
      if (blank || indent > blockIndent) {
        mask[i] = 1;
        continue;
      }
      blockIndent = null;
    }
    if (blank) continue;

    // Does this line open a block scalar? Only the tail matters here.
    const opens = /(^|\s)[|>][+-]?\d*\s*(#.*)?$/.test(line);
    if (opens) blockIndent = indent;
  }
  return mask;
}

/**
 * Tokenize a single line. `inBlock` comes from {@link blockScalarMask}.
 *
 * Line-oriented on purpose: OpenAPI documents are, it keeps the scanner linear
 * and free of the backtracking a real grammar needs, and it lets the view
 * highlight a window instead of a document.
 */
export function tokenizeLine(line: string, syntax: Syntax, inBlock = false): Token[] {
  const out: Token[] = [];
  const push = (kind: TokenKind, value: string) => {
    if (!value) return;
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += value;
    else out.push({ kind, text: value });
  };

  if (inBlock) {
    push("string", line);
    return out;
  }
  if (line.trim() === "") {
    push("plain", line);
    return out;
  }
  if (syntax === "yaml") {
    const indent = line.length - line.trimStart().length;
    tokenizeYamlLine(line, indent, push, () => {});
  } else {
    tokenizeJsonLine(line, push);
  }
  return out;
}

/**
 * Split `text` into highlight tokens.
 *
 * Whole-document convenience over {@link tokenizeLine}; the view uses the
 * per-line form. Lossless; see the module note.
 */
export function tokenize(text: string, syntax: Syntax = detectSyntax(text)): Token[] {
  const lines = text.split("\n");
  const mask = blockScalarMask(lines, syntax);
  const out: Token[] = [];
  const push = (token: Token) => {
    const last = out[out.length - 1];
    if (last && last.kind === token.kind) last.text += token.text;
    else out.push({ ...token });
  };

  lines.forEach((line, index) => {
    if (index > 0) push({ kind: "plain", text: "\n" });
    tokenizeLine(line, syntax, mask[index] === 1).forEach(push);
  });
  return out;
}

function tokenizeYamlLine(
  line: string,
  indent: number,
  push: (kind: TokenKind, value: string) => void,
  openBlock: (contentIndent: number) => void,
) {
  let i = 0;
  push("plain", line.slice(0, indent));
  i = indent;

  // Sequence dashes can stack: "- - value".
  while (line[i] === "-" && (line[i + 1] === " " || i + 1 === line.length)) {
    push("punct", "-");
    i += 1;
    const gap = line.slice(i).match(/^ */)?.[0] ?? "";
    push("plain", gap);
    i += gap.length;
  }

  const rest = line.slice(i);

  if (rest.startsWith("#")) {
    push("comment", rest);
    return;
  }

  // A key is a scalar followed by ":" at this level.
  const key = rest.match(/^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:#\s][^:#]*?)\s*:(?=\s|$)/);
  if (key) {
    push("key", key[1]);
    const between = rest.slice(key[1].length, key[0].length);
    push("punct", between);
    tokenizeYamlValue(rest.slice(key[0].length), indent, push, openBlock);
    return;
  }

  tokenizeYamlValue(rest, indent, push, openBlock);
}

function tokenizeYamlValue(
  value: string,
  indent: number,
  push: (kind: TokenKind, value: string) => void,
  openBlock: (contentIndent: number) => void,
) {
  if (!value) return;

  const lead = value.match(/^\s*/)?.[0] ?? "";
  push("plain", lead);
  const body = value.slice(lead.length);
  if (!body) return;

  if (body.startsWith("#")) {
    push("comment", body);
    return;
  }

  // Block scalar: everything more-indented than the key belongs to it.
  const block = body.match(/^[|>][+-]?\d*\s*(#.*)?$/);
  if (block) {
    push("punct", body.slice(0, body.length - (block[1]?.length ?? 0)));
    if (block[1]) push("comment", block[1]);
    openBlock(indent);
    return;
  }

  if (body.startsWith("&") || body.startsWith("*")) {
    const anchor = body.match(/^[&*][^\s]+/)?.[0] ?? body;
    push("anchor", anchor);
    tokenizeYamlValue(body.slice(anchor.length), indent, push, openBlock);
    return;
  }

  // Trailing comment after a value, but "#" inside a quoted string is content.
  if (body[0] === '"' || body[0] === "'") {
    const quoted = matchQuoted(body);
    if (quoted) {
      push("string", quoted);
      tokenizeYamlValue(body.slice(quoted.length), indent, push, openBlock);
      return;
    }
  }

  const commentAt = body.search(/\s#/);
  if (commentAt >= 0) {
    tokenizeYamlValue(body.slice(0, commentAt), indent, push, openBlock);
    push("plain", body.slice(commentAt, commentAt + 1));
    push("comment", body.slice(commentAt + 1));
    return;
  }

  push(scalarKind(body), body);
}

function tokenizeJsonLine(line: string, push: (kind: TokenKind, value: string) => void) {
  let i = 0;
  while (i < line.length) {
    const ch = line[i];

    if (ch === '"') {
      const quoted = matchQuoted(line.slice(i));
      if (quoted) {
        // A string followed by ":" is a key.
        const after = line.slice(i + quoted.length);
        push(/^\s*:/.test(after) ? "key" : "string", quoted);
        i += quoted.length;
        continue;
      }
      push("string", line.slice(i));
      return;
    }

    if (/[{}[\],:]/.test(ch)) {
      push("punct", ch);
      i += 1;
      continue;
    }

    if (/\s/.test(ch)) {
      push("plain", ch);
      i += 1;
      continue;
    }

    const word = line.slice(i).match(/^[^\s{}[\],:"]+/)?.[0] ?? ch;
    push(scalarKind(word), word);
    i += word.length;
  }
}

function scalarKind(value: string): TokenKind {
  if (NUMBER.test(value)) return "number";
  if (LITERALS.has(value)) return "literal";
  return "plain";
}

/** The quoted run at the start of `text`, or null if the quote never closes. */
function matchQuoted(text: string): string | null {
  const quote = text[0];
  if (quote !== '"' && quote !== "'") return null;
  for (let i = 1; i < text.length; i += 1) {
    if (quote === '"' && text[i] === "\\") {
      i += 1;
      continue;
    }
    if (text[i] === quote) {
      // '' is an escaped quote in single-quoted YAML.
      if (quote === "'" && text[i + 1] === "'") {
        i += 1;
        continue;
      }
      return text.slice(0, i + 1);
    }
  }
  return null;
}
