/**
 * The Markdown reader for agent messages. Beyond formatting, it must never let
 * a message become a link to anything but a web page, or load anything.
 */
import { describe, expect, it } from "vitest";
import { descriptionMarkdown, descriptionText, parseInline, parseMarkdown, safeHref } from "../markdown";

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

describe("descriptionMarkdown", () => {
  it("turns the HTML specs use for text into Markdown, and keeps relative links as text", () => {
    const html = '<p>With <a href="/connect">Connect</a>, you can <b>create</b> <code>Account</code>s.</p><p>See <a href="https://docs.example.com/x">the guide</a>.</p>';
    const markdown = descriptionMarkdown(html);
    expect(markdown).toBe("With [Connect](/connect), you can **create** `Account`s.\n\nSee [the guide](https://docs.example.com/x).");
    const blocks = parseMarkdown(markdown);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      type: "paragraph",
      children: [
        { type: "text", text: "With Connect, you can " },
        { type: "strong", children: [{ type: "text", text: "create" }] },
        { type: "text", text: " " },
        { type: "code", text: "Account" },
        { type: "text", text: "s." },
      ],
    });
  });

  it("drops other tags and scripts, and decodes entities as text", () => {
    expect(descriptionMarkdown('<div onclick="x()">Fee &amp; tax<img src="https://t.example/p.gif"><script>alert(1)</script></div>')).toBe("Fee & tax");
    expect(descriptionMarkdown("<p>1 &lt; 2 &#8212; ok</p>")).toBe("1 < 2 — ok");
  });

  it("turns lists into Markdown lists", () => {
    expect(descriptionMarkdown("<ul><li>one</li><li>two</li></ul>")).toBe("- one\n- two");
  });

  it("leaves a description without tags alone", () => {
    expect(descriptionMarkdown("Plain *text* with a < sign")).toBe("Plain *text* with a < sign");
  });
});

describe("descriptionText", () => {
  it("is one line of plain text", () => {
    expect(descriptionText("<p>The <b>id</b> of the</p><p>order.</p>")).toBe("The id of the order.");
  });
});
