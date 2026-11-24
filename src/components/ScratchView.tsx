import { useEffect, useRef, useState, type ReactNode } from "react";
import { Copy, FileCode2, History, ListPlus, Loader2, Plus, Send, SquareDashed, Trash2, TriangleAlert, X } from "lucide-react";
import { interpolate, unresolved } from "../lib/env";
import type { HistoryEntry } from "../lib/history";
import { HistoryList } from "./HistoryList";
import { SCRATCH_METHODS, scratchLabel, sendsBody, type ScratchPad, type ScratchRequest } from "../lib/scratch";
import { EmptyState } from "./EmptyState";
import { CodeEditor } from "./CodeEditor";
import { TabList } from "./TabList";
import { shortcut } from "../lib/platform";

interface Props {
  /** Every scratch request, in the order they were started. */
  requests: ScratchRequest[];
  /** The one on screen; null when there are none. */
  request: ScratchRequest | null;
  onChange: (id: string, pad: ScratchPad) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDuplicate: (id: string) => void;
  onRemove: (id: string) => void;
  /** Open the "Add to a collection" menu for this request, at a point on screen. */
  onAddToCollection: (request: ScratchRequest, position: { x: number; y: number }) => void;
  /** Open Describe as a spec, for what these requests got back. */
  onDescribe: () => void;
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
 * The scratch screen: the scratch requests in the sidebar, and the one on
 * screen with its method, URL, headers, body and send.
 *
 * There are no names, folders or Save button: a scratch request is kept the
 * way a text buffer is. Keeping one with others means adding it to a
 * collection (design rule 12).
 */
export function ScratchView(props: Props) {
  const { request } = props;
  if (!request) {
    return (
      <div className="panes">
        <ScratchSidebar {...props} />
        <div className="workarea">
          <EmptyState
            icon={<SquareDashed size={18} />}
            title="No scratch requests"
            body="A scratch request goes to any URL, without a spec. Use it to try an API before you have one."
            action={
              <button className="btn primary" onClick={props.onNew}>
                <Plus size={13} /> New request
              </button>
            }
          />
        </div>
      </div>
    );
  }
  return <ScratchEditor {...props} request={request} />;
}

function ScratchEditor({
  request: pad,
  onChange,
  vars,
  sending,
  onSend,
  record = null,
  notice = null,
  inspector,
  onAddToCollection,
  ...rest
}: Props & { request: ScratchRequest }) {
  const [tab, setTab] = useState<"body" | "headers">("body");
  // A new (empty) request is for typing a URL into, so the field gets focus.
  const urlInput = useRef<HTMLInputElement>(null);
  const recordId = record?.id ?? null;
  useEffect(() => {
    if (!recordId && pad.url.trim() === "") urlInput.current?.focus();
    // Only when another request is shown, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pad.id, recordId]);
  const resolved = interpolate(pad.url, vars);
  const missing = unresolved(pad.url, vars);
  const malformed = pad.url.trim() !== "" && missing.length === 0 && !/^https?:\/\//i.test(resolved);
  const blocked = sending || !pad.url.trim() || malformed || missing.length > 0;

  const patch = (next: Partial<ScratchPad>) => {
    const { id: _id, ...contents } = pad;
    onChange(pad.id, { ...contents, ...next });
  };
  const setHeader = (index: number, next: Partial<{ key: string; value: string }>) =>
    patch({ headers: pad.headers.map((row, i) => (i === index ? { ...row, ...next } : row)) });

  return (
    <div className="panes">
      <ScratchSidebar
        {...rest}
        request={pad}
        onChange={onChange}
        vars={vars}
        sending={sending}
        onSend={onSend}
        record={record}
        inspector={inspector}
        onAddToCollection={onAddToCollection}
      />

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
                ref={urlInput}
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
                <span style={{ flex: 1 }} />
                <button
                  className="btn sm"
                  disabled={!pad.url.trim()}
                  title={pad.url.trim() ? "Add this request to a collection, to keep it and run it with others" : "Enter a URL first"}
                  onClick={(event) => {
                    const box = event.currentTarget.getBoundingClientRect();
                    onAddToCollection(pad, { x: box.left, y: box.bottom + 4 });
                  }}
                >
                  <ListPlus size={13} /> Add to collection
                </button>
              </div>
              <div className="op-sub">
                <span className="op-sub-text">
                  Nothing is generated or checked without a spec. Add it to a collection to keep it.
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

/** The sidebar: the scratch requests, and the History of what they sent. */
function ScratchSidebar({
  requests,
  request,
  onSelect,
  onNew,
  onDuplicate,
  onRemove,
  history,
  onOpenRecord,
  onDescribe,
  record = null,
}: Props) {
  const answered = history.filter((entry) => entry.status > 0).length;
  const [side, setSide] = useState<"requests" | "history">("requests");
  return (
    <aside className="pane sidebar">
      <div className="side-head">
        <TabList<"requests" | "history">
          className="tabs"
          tabClassName="tab"
          label="Scratch"
          tabs={[
            { id: "requests", label: <>Requests <span className="meta mono">{requests.length}</span></> },
            { id: "history", label: <>History <span className="meta mono">{history.length}</span></> },
          ]}
          selected={side}
          onSelect={setSide}
        />
      </div>
      <div className="side-list">
        {side === "requests" ? (
          <>
            <button className="btn scratch-new" onClick={onNew} title={`New request (${shortcut("N")})`}>
              <Plus size={13} /> New request <span className="kbd">{shortcut("N")}</span>
            </button>
            {requests.map((item) => {
              const method = item.method.toUpperCase();
              const label = scratchLabel(item);
              let host = "";
              try {
                host = item.url.trim() ? new URL(item.url.trim()).host : "";
              } catch {
                host = "";
              }
              return (
                <div className="scratch-row" key={item.id}>
                  <button
                    className="row"
                    aria-selected={item.id === request?.id && !record}
                    onClick={() => onSelect(item.id)}
                    title={item.url.trim() || "No URL yet"}
                  >
                    <span className={`method ${method.toLowerCase()}`}>{method === "DELETE" ? "DEL" : method}</span>
                    <span style={{ minWidth: 0, display: "grid", flex: 1 }}>
                      <span className="path">{label}</span>
                      {host && host !== label && <span className="summary">{host}</span>}
                    </span>
                  </button>
                  <span className="scratch-row-actions">
                    <button className="icon-btn" aria-label={`Duplicate ${method} ${label}`} title="Duplicate" onClick={() => onDuplicate(item.id)}>
                      <Copy size={12} />
                    </button>
                    <button className="icon-btn" aria-label={`Remove ${method} ${label}`} title="Remove" onClick={() => onRemove(item.id)}>
                      <Trash2 size={12} />
                    </button>
                  </span>
                </div>
              );
            })}
          </>
        ) : (
          <>
            <HistoryList entries={history} selectedId={record?.id ?? null} onOpen={onOpenRecord} />
            {history.length === 0 && (
              <EmptyState icon={<History size={18} />} title="Nothing sent yet" body="Requests you send from here are kept in History, on this computer." />
            )}
          </>
        )}
      </div>
      <div className="scratch-foot">
        <button
          className="btn ghost"
          disabled={!answered}
          onClick={onDescribe}
          title={
            answered
              ? "Write a draft OpenAPI spec from what these requests got back. Nothing is sent."
              : "Send a request first: the spec is written from the responses in History"
          }
        >
          <FileCode2 size={13} /> Describe as a spec
        </button>
      </div>
    </aside>
  );
}
