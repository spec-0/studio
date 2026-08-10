/**
 * The document — the spec itself, as text and as a reference.
 *
 * Studio could always tell you what an API *contains*; it could never show you
 * the document. Two tabs, because the two readings answer different questions:
 * `Raw` is the bytes you imported, which is what you need when you are about to
 * edit the file or work out why a parser disagrees with you; `Reference` is the
 * same document rendered the way `app.spec0.io` renders it, which is what you
 * need when you are reading the API rather than the file.
 *
 * Named `Reference` to match the dashboard, whose details page already routes
 * this view as `?tab=reference`. One word for one thing across the desktop app,
 * the dashboard and the registry beats a locally-nicer synonym.
 *
 * Both tabs are free-tier: they render the text the library already holds, with
 * no account and no request to spec0. Only the consumer count needs a session,
 * and its absence changes nothing else on the screen.
 */

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, ExternalLink, GitBranch, Upload, Users } from "lucide-react";
import { blockScalarMask, detectSyntax, tokenizeLine } from "../lib/highlight";
import { describeGit, refLabel, type GitInfo } from "../lib/git";
import type { ApiConsumers } from "../lib/spec0";

const ScalarReference = lazy(() => import("./ScalarReference"));

export type DocumentTab = "raw" | "reference";

interface Props {
  title: string;
  version: string;
  text: string;
  dark: boolean;
  tab: DocumentTab;
  onTabChange: (tab: DocumentTab) => void;
  git: GitInfo | null;
  consumers: ApiConsumers | null;
  onOpenConsumers: () => void;
  /**
   * Null when this document can't be published — the reason, so the absence of
   * the button is explained where someone would look for it rather than being
   * a silence they have to interpret.
   */
  publishBlockedReason: string | null;
  onPublish: () => void;
}

/** Matches `--doc-line` in styles.css; the window maths needs a number. */
const LINE_HEIGHT = 20;
/** Lines drawn beyond the viewport, so a fast scroll doesn't show blank rows. */
const OVERSCAN = 20;

export function DocumentView({
  title,
  version,
  text,
  dark,
  tab,
  onTabChange,
  git,
  consumers,
  onOpenConsumers,
  publishBlockedReason,
  onPublish,
}: Props) {
  return (
    <section className="doc">
      <header className="doc-head">
        <div className="doc-id">
          <h2>{title}</h2>
          {version && <span className="chip">{version}</span>}
        </div>

        <div className="doc-facts">
          {git && <GitChip info={git} />}
          {consumers && <ConsumersChip consumers={consumers} onOpen={onOpenConsumers} />}
        </div>

        <div className="doc-actions">
          {/* Availability never depends on drift — the git chip supplies
              emphasis, this supplies the action. */}
          {publishBlockedReason === null ? (
            <button className="btn tight" onClick={onPublish}>
              <Upload size={13} /> Publish to spec0
            </button>
          ) : (
            <span className="meta publish-why" title={publishBlockedReason}>
              {publishBlockedReason}
            </span>
          )}
        </div>

        <div className="doc-tabs" role="tablist" aria-label="Document">
          <button role="tab" aria-selected={tab === "raw"} onClick={() => onTabChange("raw")}>
            Raw
          </button>
          <button
            role="tab"
            aria-selected={tab === "reference"}
            onClick={() => onTabChange("reference")}
          >
            Reference
          </button>
        </div>
      </header>

      {tab === "raw" ? (
        <RawPane text={text} />
      ) : (
        <div className="doc-reference">
          <Suspense fallback={<p className="empty">Rendering the reference…</p>}>
            <ScalarReference text={text} dark={dark} />
          </Suspense>
        </div>
      )}
    </section>
  );
}

/**
 * Where the file came from — never where the API runs.
 *
 * The title spells that out, and the dirty marker exists so a commit id is
 * never presented as describing bytes that have since been edited.
 */
function GitChip({ info }: { info: GitInfo }) {
  return (
    <span className={`chip git${info.dirty ? " dirty" : ""}`} title={describeGit(info)}>
      <GitBranch size={12} />
      {refLabel(info)}
      <span className="meta">{info.sha}</span>
      {info.dirty && <span className="meta warn">uncommitted</span>}
    </span>
  );
}

function ConsumersChip({
  consumers,
  onOpen,
}: {
  consumers: ApiConsumers;
  onOpen: () => void;
}) {
  const { total, approved } = consumers;
  const label = total === 1 ? "1 consumer" : `${total} consumers`;
  const detail =
    total === 0
      ? "Nothing depends on this API yet, according to spec0."
      : approved === total
        ? `${label}, all approved. Open the consumers view on spec0.`
        : `${label}, ${approved} approved. Open the consumers view on spec0.`;

  return (
    <button className="chip link" onClick={onOpen} title={detail}>
      <Users size={12} />
      {label}
      <ExternalLink size={11} />
    </button>
  );
}

/**
 * The document as text.
 *
 * Windowed. Studio's parser handles a 7.6MB spec in about 30ms and it would be
 * a poor trade to hand that back at the last step by asking the webview to lay
 * out a quarter of a million lines. Only the visible slice is tokenized, which
 * is why the highlighter exposes a per-line entry point and a block-scalar mask
 * computed once for the whole document.
 */
function RawPane({ text }: { text: string }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);
  const [height, setHeight] = useState(600);
  const [copied, setCopied] = useState(false);

  const { lines, mask, syntax } = useMemo(() => {
    const syntax = detectSyntax(text);
    const lines = text.split("\n");
    return { lines, mask: blockScalarMask(lines, syntax), syntax };
  }, [text]);

  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const measure = () => setHeight(node.clientHeight || 600);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const first = Math.max(0, Math.floor(offset / LINE_HEIGHT) - OVERSCAN);
  const last = Math.min(lines.length, Math.ceil((offset + height) / LINE_HEIGHT) + OVERSCAN);
  const window = lines.slice(first, last);
  const gutter = String(lines.length).length;

  const copy = useCallback(() => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  }, [text]);

  return (
    <div className="doc-raw">
      <div className="doc-raw-bar">
        <span className="meta">
          {lines.length.toLocaleString()} lines · {syntax.toUpperCase()}
        </span>
        <button className="icon-btn tight" onClick={copy} aria-label="Copy the document">
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>

      <div
        className="doc-raw-scroll code"
        ref={viewport}
        onScroll={(event) => setOffset(event.currentTarget.scrollTop)}
      >
        <div style={{ height: lines.length * LINE_HEIGHT, position: "relative" }}>
          <div style={{ position: "absolute", top: first * LINE_HEIGHT, left: 0, right: 0 }}>
            {window.map((line, i) => {
              const index = first + i;
              return (
                <div className="doc-line" key={index}>
                  <span className="doc-gutter" style={{ width: `${gutter}ch` }}>
                    {index + 1}
                  </span>
                  <span className="doc-code">
                    {tokenizeLine(line, syntax, mask[index] === 1).map((token, t) => (
                      <span key={t} className={`tk-${token.kind}`}>
                        {token.text}
                      </span>
                    ))}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
