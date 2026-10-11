import { Fragment, useMemo, type ReactNode } from "react";
import { parseMarkdown, type Block, type Inline } from "../../lib/markdown";
import { openInBrowser } from "../../lib/store";

/**
 * An agent's message, formatted. Built from `parseMarkdown`'s plain data as
 * React elements, never as HTML, so a message can't add markup or load
 * anything. Links open in the system browser, and only http(s) ones are links.
 */
export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <div className="md">{blocks.map((block, index) => renderBlock(block, index))}</div>;
}

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.type) {
    case "heading": {
      const Tag = (`h${Math.min(block.level + 2, 6)}`) as "h3" | "h4" | "h5" | "h6";
      return <Tag key={key}>{renderInline(block.children)}</Tag>;
    }
    case "paragraph":
      return <p key={key}>{renderInline(block.children)}</p>;
    case "code":
      return (
        <pre key={key} className="md-code" data-lang={block.lang || undefined}>
          <code>{block.text}</code>
        </pre>
      );
    case "list": {
      const items = block.items.map((item, index) => <li key={index}>{renderInline(item)}</li>);
      return block.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
    }
    case "quote":
      return <blockquote key={key}>{renderInline(block.children)}</blockquote>;
    case "rule":
      return <hr key={key} />;
  }
}

function renderInline(nodes: Inline[]): ReactNode {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "text":
        return <Fragment key={index}>{withBreaks(node.text)}</Fragment>;
      case "code":
        return <code key={index}>{node.text}</code>;
      case "strong":
        return <strong key={index}>{renderInline(node.children)}</strong>;
      case "em":
        return <em key={index}>{renderInline(node.children)}</em>;
      case "link":
        return (
          <a
            key={index}
            href={node.href}
            title={node.href}
            onClick={(event) => {
              event.preventDefault();
              void openInBrowser(node.href);
            }}
          >
            {renderInline(node.children)}
          </a>
        );
    }
  });
}

function withBreaks(text: string): ReactNode {
  const lines = text.split("\n");
  return lines.map((line, index) => (
    <Fragment key={index}>
      {index > 0 && <br />}
      {line}
    </Fragment>
  ));
}
