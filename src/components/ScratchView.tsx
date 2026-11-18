import { useState, type ReactNode } from "react";
import { History, Loader2, Plus, Send, TriangleAlert, X } from "lucide-react";
import { interpolate, unresolved } from "../lib/env";
import type { HistoryEntry } from "../lib/history";
import { HistoryList } from "./HistoryList";
import { SCRATCH_METHODS, sendsBody, type ScratchPad } from "../lib/scratch";
import { EmptyState } from "./EmptyState";
import { CodeEditor } from "./CodeEditor";
import { TabList } from "./TabList";
import { shortcut } from "../lib/platform";

interface Props {
  pad: ScratchPad;
  onChange: (pad: ScratchPad) => void;
  vars: Record<string, string>;
  sending: boolean;
  onSend: () => void;
  /** Scratch calls only. The spec-driven log lives with its API. */
  history: HistoryEntry[];
  /** Open a recorded scratch call, read-only. */
  onOpenRecord: (entry: HistoryEntry) => void;
  /** The recorded call open in the work area; it replaces the editor while it's open. */
  record?: { id: string; view: ReactNode } | null;
  /** A note above the editor, e.g. that it was filled from a recording. */
  notice?: ReactNode;
  /** The response pane. Passed in so all Inspector wiring stays in one place. */
  inspector: ReactNode;
}

/**
 * The scratch pad's screen: method, URL, headers, body, send.
 *
 * Deliberately one screen with no persistence controls: no Save, no name, no
 * second tab. The absence is the design: every affordance for keeping a
 * request here is the first step toward a collection manager, and the answer to
 * "I want to keep this" is a spec, not a folder.
 */
export function ScratchView({
  pad,
  onChange,
  vars,
  sending,
  onSend,
  history,
  onOpenRecord,
  record = null,
  notice = null,
  inspector,
}: Props) {
  const [tab, setTab] = useState<"body" | "headers">("body");
  const resolved = interpolate(pad.url, vars);
  const missing = unresolved(pad.url, vars);
  const malformed = pad.url.trim() !== "" && missing.length === 0 && !/^https?:\/\//i.test(resolved);
  const blocked = sending || !pad.url.trim() || malformed || missing.length > 0;

  const patch = (next: Partial<ScratchPad>) => onChange({ ...pad, ...next });
  const setHeader = (index: number, next: Partial<{ key: string; value: string }>) =>
    patch({ headers: pad.headers.map((row, i) => (i === index ? { ...row, ...next } : row)) });

  return (
    <div className="panes">
      <aside className="pane sidebar">
        <div className="side-head">
          <div className="tabs">
            <button className="tab" aria-selected>
              History <span className="meta mono">{history.length}</span>
            </button>
          </div>
        </div>
        <div className="side-list">
          <HistoryList
            entries={history}
            selectedId={record?.id ?? null}
            onOpen={onOpenRecord}
          />
          {history.length === 0 && (
            <EmptyState icon={<History size={18} />} title="Nothing sent yet" body="Requests you send from here are kept in History, on this computer." />
          )}
        </div>
      </aside>

      <div className="workarea">
        {record ? (
          record.view
        ) : (
        <>
        {notice}
        <div className="urlbar">
          <div className="addr">
            <select
              className={`method-select addr-method-select method-chip ${pad.method.toLowerCase()}`}
              value={pad.method}
              onChange={(event) => patch({ method: event.target.value })}
              aria-label="Method"
            >
              {SCRATCH_METHODS.map((method) => (
                <option key={method} value={method}>
                  {method}
                </option>
              ))}
            </select>
            <div className="url-field scratch-url">
              <input
                value={pad.url}
                placeholder="https://api.example.com/things  ·  or {{baseUrl}}/things"
                spellCheck={false}
                onChange={(event) => patch({ url: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !blocked) onSend();
                }}
                aria-label="URL"
              />
            </div>
          </div>

          <button className="btn primary send" disabled={blocked} onClick={onSend} title={`Send (${shortcut("↵")})`}>
            {sending ? <Loader2 size={13} className="spin" /> : <Send size={13} />}
            {sending ? "Sending…" : "Send"}
            <span className="kbd">{shortcut("↵")}</span>
          </button>

          {(missing.length > 0 || malformed) && (
            <div className="urlbar-note">
              <TriangleAlert size={12} />
              {missing.length > 0
                ? `undefined in this environment: ${missing.map((name) => `{{${name}}}`).join(" ")}`
                : "URL needs http:// or https://"}
            </div>
          )}
        </div>

        <div className="split">
          <section className="pane request">
            <div className="op-head">
              <div className="op-title">
                <span className="op-summary-text">Scratch request</span>
              </div>
              <div className="op-sub">
                <span className="op-sub-text">
                  One pad, on purpose: nothing is generated or checked. Add the API to get both back.
                </span>
              </div>
            </div>

            <TabList<"body" | "headers">
              className="ptabs request-tabs-list"
              tabClassName="ptab"
              label="Request"
              tabs={[
                { id: "body", label: "Body" },
                { id: "headers", label: <>Headers <span className="c">{pad.headers.length}</span></> },
              ]}
              selected={tab}
              onSelect={setTab}
            />

            <div className="op-body">
              {tab === "headers" && (
                <div className="tab-pane">
                  {pad.headers.map((row, index) => (
                    <div className="field" key={index}>
                      <div className="field-label">
                        <input
                          value={row.key}
                          placeholder="Header"
                          onChange={(event) => setHeader(index, { key: event.target.value })}
                        />
                      </div>
                      <div style={{ flex: 1, display: "flex", gap: 6 }}>
                        <input
                          value={row.value}
                          placeholder="Value ({{vars}} work here)"
                          onChange={(event) => setHeader(index, { value: event.target.value })}
                        />
                        <button
                          className="icon-btn"
                          aria-label="Remove header"
                          title="Remove header"
                          onClick={() => patch({ headers: pad.headers.filter((_, i) => i !== index) })}
                        >
                          <X size={13} />
                        </button>
                      </div>
                    </div>
                  ))}
                  <button
                    className="btn"
                    style={{ marginTop: pad.headers.length ? 8 : 0 }}
                    onClick={() => patch({ headers: [...pad.headers, { key: "", value: "" }] })}
                  >
                    <Plus size={13} /> Add header
                  </button>
                </div>
              )}

              {tab === "body" && (
                <div className="tab-pane">
                  {/* Collapsed rather than shown disabled: a large dead editor is a
                      worse way of saying "GET sends no body" than one line is. What
                      was typed is kept, so switching method back restores it. */}
                  {sendsBody(pad.method) ? (
                    <>
                      <div className="pane-toolbar">
                        <span>Sent as it is. Content-Type is worked out unless you set it in Headers.</span>
                      </div>
                      <CodeEditor value={pad.body} onChange={(body) => patch({ body })} label="Request body" />
                    </>
                  ) : (
                    <p className="meta">
                      {pad.method} sends no body.
                      {pad.body.trim() ? " What you typed is kept for when you switch back." : ""}
                    </p>
                  )}
                </div>
              )}
            </div>
          </section>
          {inspector}
        </div>
        </>
        )}
      </div>
    </div>
  );
}
