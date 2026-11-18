import { descriptionMarkdown } from "../lib/markdown";
import { Markdown } from "./agent-chat/Markdown";

/**
 * A description from the spec: its Markdown, and the simple HTML some specs
 * use, formatted (see `descriptionMarkdown`). Never rendered as HTML, and links
 * open in the system browser.
 */
export function Description({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className}>
      <Markdown text={descriptionMarkdown(text)} />
    </div>
  );
}
