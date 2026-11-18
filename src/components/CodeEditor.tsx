import { useMemo, useRef } from "react";
import { blockScalarMask, detectSyntax, tokenizeLine } from "../lib/highlight";

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** Accessible name for the text area. */
  label: string;
  className?: string;
}

/** Past this many lines the editor stops highlighting; typing must stay instant. */
const HIGHLIGHT_LIMIT = 3000;

/**
 * A plain text area over a highlighted copy of its text, with line numbers.
 *
 * The text area does the editing (caret, selection, undo, IME) and is
 * transparent; the copy behind it is drawn with `lib/highlight.ts` and kept
 * scrolled with it. Lines don't wrap, so the two always line up. No editor
 * library: this is the one place Studio edits code, and it's small.
 */
export function CodeEditor({ value, onChange, label, className }: Props) {
  const area = useRef<HTMLTextAreaElement>(null);
  const back = useRef<HTMLPreElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => value.split("\n"), [value]);
  const syntax = useMemo(() => detectSyntax(value), [value]);
  const highlight = lines.length <= HIGHLIGHT_LIMIT;
  const mask = useMemo(() => (highlight ? blockScalarMask(lines, syntax) : null), [lines, syntax, highlight]);

  const sync = () => {
    const el = area.current;
    if (!el) return;
    if (back.current) {
      back.current.scrollTop = el.scrollTop;
      back.current.scrollLeft = el.scrollLeft;
    }
    if (gutter.current) gutter.current.scrollTop = el.scrollTop;
  };

  return (
    <div className={`code-editor${className ? ` ${className}` : ""}`} style={{ height: editorHeight(lines.length) }}>
      <div className="code-editor-gutter" ref={gutter} aria-hidden>
        {lines.map((_, index) => (
          <div key={index}>{index + 1}</div>
        ))}
      </div>
      <div className="code-editor-main">
        <pre className="code-editor-back" ref={back} aria-hidden>
          {lines.map((line, index) => (
            <div key={index}>
              {highlight
                ? tokenizeLine(line, syntax, mask?.[index] === 1).map((token, i) =>
                    token.kind === "plain" ? token.text : (
                      <span key={i} className={`syn-${token.kind}`}>
                        {token.text}
                      </span>
                    ),
                  )
                : line}
              {"\n"}
            </div>
          ))}
        </pre>
        <textarea
          ref={area}
          className="code-editor-input"
          aria-label={label}
          value={value}
          wrap="off"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(event) => onChange(event.target.value)}
          onScroll={sync}
          onKeyDown={(event) => {
            // Tab indents, as in any code editor; Shift+Tab still leaves the field.
            if (event.key !== "Tab" || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
            event.preventDefault();
            const el = event.currentTarget;
            const { selectionStart: start, selectionEnd: end } = el;
            const next = `${value.slice(0, start)}  ${value.slice(end)}`;
            onChange(next);
            requestAnimationFrame(() => el.setSelectionRange(start + 2, start + 2));
          }}
        />
      </div>
    </div>
  );
}

/** Tall enough for the text (20px a line), within reason. */
function editorHeight(lineCount: number): number {
  return Math.min(Math.max(lineCount * 20 + 18, 180), 520);
}
