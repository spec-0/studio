/**
 * The Markdown reader for agent messages. Beyond formatting, it must never let
 * a message become a link to anything but a web page, or load anything.
 */
import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown, safeHref } from "../markdown";

describe("blocks", () => {
  it("reads headings, paragraphs, lists, quotes, rules and code", () => {
    const blocks = parseMarkdown(
      [
        "## Result",
        "The step **failed**.",
        "",
        "- first",
        "- second",
        "",
        "1. one",
        "2. two",
        "",
        "> quoted",
        "",
        "---",
        "```yaml",
        "openapi: 3.1.0",
        "  # kept as written",
        "```",
      ].join("\n"),
    );
    expect(blocks.map((block) => block.type)).toEqual(["heading", "paragraph", "list", "list", "quote", "rule", "code"]);
    expect(blocks[2]).toMatchObject({ type: "list", ordered: false });
    expect(blocks[3]).toMatchObject({ type: "list", ordered: true });
    expect(blocks[6]).toEqual({ type: "code", lang: "yaml", text: "openapi: 3.1.0\n  # kept as written" });
  });

  it("keeps an unclosed code block to the end", () => {
    expect(parseMarkdown("```\nstill code")).toEqual([{ type: "code", lang: "", text: "still code" }]);
  });

  it("joins a wrapped list item", () => {
    const [list] = parseMarkdown("- a long item\n  that wraps\n- next");
    expect(list.type === "list" && list.items).toHaveLength(2);
  });
});

describe("inline", () => {
  it("reads code, bold, italics and links", () => {
    expect(parseInline("Use `GET /orders` and **check** the *status*.")).toEqual([
      { type: "text", text: "Use " },
      { type: "code", text: "GET /orders" },
      { type: "text", text: " and " },
      { type: "strong", children: [{ type: "text", text: "check" }] },
      { type: "text", text: " the " },
      { type: "em", children: [{ type: "text", text: "status" }] },
      { type: "text", text: "." },
    ]);
  });

  it("leaves markers that aren't formatting alone", () => {
    expect(parseInline("a * b and snake_case_name")).toEqual([{ type: "text", text: "a * b and snake_case_name" }]);
  });

  it("makes web links, and bare URLs, into links", () => {
    expect(parseInline("[docs](https://spec0.io/docs)")).toEqual([
      { type: "link", href: "https://spec0.io/docs", children: [{ type: "text", text: "docs" }] },
    ]);
    const bare = parseInline("see https://example.com/a.");
    expect(bare[1]).toEqual({ type: "link", href: "https://example.com/a", children: [{ type: "text", text: "https://example.com/a" }] });
    expect(bare[2]).toEqual({ type: "text", text: "." });
  });

  it("never makes a link out of anything but http(s)", () => {
    const script = parseInline("[click](javascript:alert(1))");
    expect(script.some((node) => node.type === "link")).toBe(false);
    expect(parseInline("[click](javascript:void)")).toEqual([{ type: "text", text: "click" }]);
    expect(parseInline("[f](file:///etc/passwd)")).toEqual([{ type: "text", text: "f" }]);
    expect(safeHref("data:text/html,hi")).toBeNull();
    expect(safeHref("not a url")).toBeNull();
  });

  it("shows an image as its description and loads nothing", () => {
    expect(parseInline("![diagram](https://evil.test/track.png)")).toEqual([{ type: "text", text: "[image: diagram]" }]);
  });

  it("reads a long message in reasonable time", () => {
    const text = "word **bold** `code` ".repeat(5000);
    const started = performance.now();
    parseInline(text);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
