import { describe, expect, it } from "vitest";
import { blockScalarMask, detectSyntax, tokenize, tokenizeLine, type Token } from "../highlight";

const render = (tokens: Token[]) => tokens.map((t) => t.text).join("");
const kindOf = (tokens: Token[], text: string) => tokens.find((t) => t.text === text)?.kind;

const SPEC = `openapi: 3.0.3
info:
  title: Orders
  version: "1.4.0"
  description: |
    A block scalar. This line has a colon: and it is prose, not a key.
    # and this hash is prose too
paths:
  /orders/{id}:
    get:
      deprecated: false
      responses:
        "200":
          description: ok  # trailing comment
`;

describe("detectSyntax", () => {
  it("calls a document that opens with a brace JSON", () => {
    expect(detectSyntax('  {"openapi": "3.0.3"}')).toBe("json");
    expect(detectSyntax("[1, 2]")).toBe("json");
  });

  it("calls anything else YAML", () => {
    expect(detectSyntax("openapi: 3.0.3")).toBe("yaml");
    expect(detectSyntax("# a comment first\nopenapi: 3.0.3")).toBe("yaml");
  });
});

describe("tokenize", () => {
  // The property that matters most: what is drawn is what is on disk. If this
  // fails the Raw tab is lying, which is worse than showing no colour at all.
  it("is lossless for YAML", () => {
    expect(render(tokenize(SPEC))).toBe(SPEC);
  });

  it("is lossless for JSON", () => {
    const json = JSON.stringify({ openapi: "3.0.3", info: { title: "x", version: 1 } }, null, 2);
    expect(render(tokenize(json))).toBe(json);
  });

  it("is lossless for input that is neither", () => {
    const junk = "not a spec\n\n\t{{{ unbalanced \"unterminated\n";
    expect(render(tokenize(junk))).toBe(junk);
  });

  it("is lossless for an empty document", () => {
    expect(render(tokenize(""))).toBe("");
  });

  it("marks mapping keys", () => {
    const tokens = tokenize("openapi: 3.0.3\ninfo:\n  title: Orders\n");
    expect(kindOf(tokens, "openapi")).toBe("key");
    expect(kindOf(tokens, "info")).toBe("key");
    expect(kindOf(tokens, "title")).toBe("key");
  });

  it("marks a quoted key that contains a colon", () => {
    const tokens = tokenize('  "/orders/{id}":\n');
    expect(kindOf(tokens, '"/orders/{id}"')).toBe("key");
  });

  it("distinguishes numbers, literals and strings", () => {
    const tokens = tokenize('a: 1.4\nb: false\nc: "1.4"\nd: null\n');
    expect(kindOf(tokens, "1.4")).toBe("number");
    expect(kindOf(tokens, "false")).toBe("literal");
    expect(kindOf(tokens, '"1.4"')).toBe("string");
    expect(kindOf(tokens, "null")).toBe("literal");
  });

  it("treats a block scalar's contents as text, not structure", () => {
    const tokens = tokenize(SPEC);
    // "This line has a colon: ..." must not produce a key token for the prose.
    const keys = tokens.filter((t) => t.kind === "key").map((t) => t.text);
    expect(keys).not.toContain("A block scalar. This line has a colon");
    expect(keys).toContain("description");
  });

  it("does not read a hash inside a block scalar as a comment", () => {
    const tokens = tokenize(SPEC);
    const comments = tokens.filter((t) => t.kind === "comment").map((t) => t.text.trim());
    expect(comments.some((c) => c.includes("this hash is prose"))).toBe(false);
    expect(comments.some((c) => c.includes("trailing comment"))).toBe(true);
  });

  it("keeps a hash inside a quoted string out of the comment token", () => {
    const tokens = tokenize('summary: "colour #5B4CF5"\n');
    expect(kindOf(tokens, '"colour #5B4CF5"')).toBe("string");
    expect(tokens.some((t) => t.kind === "comment")).toBe(false);
  });

  it("marks sequence dashes as punctuation, not part of the value", () => {
    const tokens = tokenize("servers:\n  - url: https://api.example.com\n");
    expect(kindOf(tokens, "url")).toBe("key");
    expect(tokens.some((t) => t.kind === "punct" && t.text.includes("-"))).toBe(true);
  });

  it("marks JSON keys but not JSON string values", () => {
    const tokens = tokenize('{"title": "Orders"}', "json");
    expect(kindOf(tokens, '"title"')).toBe("key");
    expect(kindOf(tokens, '"Orders"')).toBe("string");
  });

  it("survives an unterminated string without dropping it", () => {
    const line = 'title: "never closed\n';
    expect(render(tokenize(line))).toBe(line);
  });

  it("handles CRLF without eating the carriage return", () => {
    const crlf = "openapi: 3.0.3\r\ninfo:\r\n";
    expect(render(tokenize(crlf))).toBe(crlf);
  });
});

describe("windowed highlighting", () => {
  // The Raw view highlights only what is on screen. If a windowed line came out
  // differently from the same line in a whole-document pass, scrolling would
  // change the colours of text that hasn't changed.
  it("agrees with a whole-document pass, line for line", () => {
    const lines = SPEC.split("\n");
    const mask = blockScalarMask(lines, "yaml");

    const windowed = lines
      .map((line, i) => render(tokenizeLine(line, "yaml", mask[i] === 1)))
      .join("\n");
    expect(windowed).toBe(SPEC);

    const whole = tokenize(SPEC);
    const wholeByLine = render(whole).split("\n");
    lines.forEach((line, i) => {
      expect(wholeByLine[i]).toBe(line);
    });
  });

  it("marks block-scalar body lines and nothing else", () => {
    const lines = SPEC.split("\n");
    const mask = blockScalarMask(lines, "yaml");
    const inBlock = lines.filter((_, i) => mask[i] === 1);

    expect(inBlock.some((l) => l.includes("it is prose, not a key"))).toBe(true);
    expect(inBlock.some((l) => l.includes("this hash is prose too"))).toBe(true);
    expect(inBlock.some((l) => l.includes("paths:"))).toBe(false);
  });

  it("has no block scalars in JSON", () => {
    const lines = ['{"a": "|"}', '  "b": 1'];
    expect(Array.from(blockScalarMask(lines, "json"))).toEqual([0, 0]);
  });

  it("builds the mask for a large document without tokenizing it", () => {
    // The Stripe-scale case: masking is the only whole-document work the view
    // does, so it has to stay cheap.
    const big = Array.from({ length: 200_000 }, (_, i) => `  key${i}: value${i}`);
    const started = performance.now();
    const mask = blockScalarMask(big, "yaml");
    const elapsed = performance.now() - started;

    expect(mask.length).toBe(200_000);
    expect(elapsed).toBeLessThan(1000);
  });
});
