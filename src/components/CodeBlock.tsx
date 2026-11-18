import { useMemo } from "react";
import { blockScalarMask, tokenizeLine, type Syntax } from "../lib/highlight";

/** Past this many lines a body is shown as plain text: highlighting it would cost more than it gives. */
const HIGHLIGHT_LIMIT = 5000;

interface Props {
  text: string;
  /** JSON or YAML get highlighted; anything else is shown as it is. */
  syntax: Syntax | "plain";
  /** Long lines wrap instead of scrolling sideways. */
  wrap?: boolean;
  className?: string;
}

/**
 * Code on the dark code surface, the same in both themes: a line-number gutter
 * and the text, highlighted with `lib/highlight.ts`. One row per line, so line
 * numbers stay next to their line when it wraps. Read-only.
 */
export function CodeBlock({ text, syntax, wrap = false, className }: Props) {
  const lines = useMemo(() => text.split("\n"), [text]);
  const highlight = syntax !== "plain" && lines.length <= HIGHLIGHT_LIMIT;
  const mask = useMemo(
    () => (highlight ? blockScalarMask(lines, syntax as Syntax) : null),
    [lines, syntax, highlight],
  );
  return (
    <div className={`code-block${wrap ? " wrap" : ""}${className ? ` ${className}` : ""}`}>
      {lines.map((line, index) => (
        <div className="code-line" key={index}>
          <span className="code-num" aria-hidden>
            {index + 1}
          </span>
          <span className="code-text">
            {highlight
              ? tokenizeLine(line, syntax as Syntax, mask?.[index] === 1).map((token, i) =>
                  token.kind === "plain" ? token.text : (
                    <span key={i} className={`syn-${token.kind}`}>
                      {token.text}
                    </span>
                  ),
                )
              : line}
            {line === "" ? "​" : null}
          </span>
        </div>
      ))}
    </div>
  );
}
