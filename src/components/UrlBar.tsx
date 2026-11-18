import { useEffect, useMemo, useRef, useState } from "react";
import { BookmarkPlus, Check, ChevronDown, Loader2, Send, ShieldAlert, TriangleAlert } from "lucide-react";
import { interpolate, unresolved } from "../lib/env";
import type { OperationSpec } from "../lib/spec";
import type { Target } from "../lib/targets";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { isMac, shortcut } from "../lib/platform";
import { copyCurlShortcutLabel } from "../lib/shortcuts";

export type { Target };

interface Props {
  op: OperationSpec;
  targets: Target[];
  specServers: string[];
  mockUrl: string | null;
  value: string;
  onChange: (value: string) => void;
  vars: Record<string, string>;
  sending: boolean;
  onSend: () => void;
  /** Promote whatever is typed into a reusable environment variable. */
  onSaveTarget: (url: string) => void;
  /**
   * This target's certificate is not being verified.
   *
   * Shown here, on every request, rather than only in the settings that turned
   * it on. A decision made once in a dialog is invisible by the following week;
   * the whole point of scoping relaxed verification to a host is being able to
   * see when it's in effect.
   */
  unverified?: boolean;
  onOpenConnection?: () => void;
  /**
   * The targeted platform environment runs a different version than the spec we hold.
   *
   * Said here rather than in the response pane because it explains the request being
   * built, not the answer that comes back: a body shaped by 1.5.0's schema sent at a
   * host still running 1.4.0 can fail in ways that look like the client's fault.
   */
  envSkew?: { name: string; live: string; held: string } | null;
  /** Send's menu: the request as a cURL command (⇧⌘C). */
  onCopyCurl?: () => Promise<boolean>;
  /** Send's menu: add the request on screen to a collection, from where the menu is. */
  onAddToCollection?: (position: { x: number; y: number }) => void;
}

/**
 * The address bar: method, base URL, and the operation's path, at the top of the
 * workspace where a developer expects to find it.
 *
 * The base URL is free text with the spec's servers as suggestions: pointing at
 * localhost or a host the spec never mentions is the common case, and a spec with
 * no `servers:` block must still be usable. The path is the operation's and isn't
 * editable; that's what makes this a spec-native client rather than a URL box.
 */
export function UrlBar({
  op,
  targets,
  specServers,
  mockUrl,
  value,
  onChange,
  vars,
  sending,
  onSend,
  onSaveTarget,
  unverified = false,
  onOpenConnection,
  envSkew,
  onCopyCurl,
  onAddToCollection,
}: Props) {
  const urlInput = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // "Custom URL…" was chosen: the base URL is shown for editing even when it
  // happens to equal one of the targets.
  const [custom, setCustom] = useState(false);
  const sendMore = useRef<HTMLButtonElement>(null);
  const [sendMenu, setSendMenu] = useState<{ x: number; y: number } | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => setCustom(false), [op.id]);

  const suggestions = useMemo(() => {
    const all = [
      ...(mockUrl ? [mockUrl] : []),
      ...specServers,
      "http://localhost:8080",
      "http://localhost:3000",
    ];
    return [...new Set(all.filter(Boolean))];
  }, [specServers, mockUrl]);

  const resolved = interpolate(value, vars);
  const missing = unresolved(value, vars);
  // A target is recognised from the address as written, so a `{{baseUrl}}` stays
  // visible and editable rather than hiding behind the target it resolves to.
  const knownTarget = custom ? undefined : targetFor(targets, value);
  const malformed = value.trim() !== "" && missing.length === 0 && !/^https?:\/\//i.test(resolved);
  const blocked = sending || !value.trim() || malformed || missing.length > 0;

  const pick = (target: Target | null) => {
    setMenu(null);
    if (target) {
      setCustom(false);
      onChange(target.url);
      return;
    }
    // Custom keeps what's there, so a known address can be edited rather than retyped.
    setCustom(true);
    requestAnimationFrame(() => {
      urlInput.current?.focus();
      urlInput.current?.select();
    });
  };

  const openMenu = () => {
    const rect = picker.current?.getBoundingClientRect();
    if (rect) setMenu({ x: rect.left, y: rect.bottom + 4 });
  };

  const items: MenuItem[] = [
    ...targets.map((target) => ({
      text: `${targetLabel(target).name} ${target.url}`,
      label: (
        <span className="target-item">
          <span className="target-item-check" aria-hidden>
            {knownTarget?.url === target.url ? <Check size={13} /> : null}
          </span>
          <TargetDot kind={target.kind} />
          <span className="target-item-text">
            <span>
              {targetLabel(target).name}
              {targetLabel(target).port && <span className="mono target-port">{targetLabel(target).port}</span>}
            </span>
            {/* A server's name is already its address; say the address only when it adds something. */}
            {target.url.replace(/^https?:\/\//, "").replace(/\/$/, "") !== targetLabel(target).name && (
              <span className="mono target-item-url">{target.url}</span>
            )}
          </span>
        </span>
      ),
      onSelect: () => pick(target),
    })),
    {
      text: "Custom URL…",
      separator: targets.length > 0,
      label: (
        <span className="target-item">
          <span className="target-item-check" aria-hidden>
            {!knownTarget ? <Check size={13} /> : null}
          </span>
          <span className="dot none" aria-hidden />
          <span className="target-item-text">Custom URL…</span>
        </span>
      ),
      onSelect: () => pick(null),
    },
  ];

  const current = knownTarget ? targetLabel(knownTarget) : null;

  return (
    <div className="urlbar">
      <div className={`addr${unverified ? " unverified" : ""}`}>
        <span className={`addr-method method-chip ${op.method.toLowerCase()}`}>{op.method}</span>

        {/* A developer must never be unsure which target they just hit, so the
            target is named here, in words, and its address is a hover away. */}
        {targets.length > 0 && (
          <button
            ref={picker}
            type="button"
            className="addr-target"
            aria-haspopup="menu"
            aria-expanded={Boolean(menu)}
            title={knownTarget ? knownTarget.url : "Choose where this request goes"}
            onClick={() => (menu ? setMenu(null) : openMenu())}
          >
            {knownTarget && <TargetDot kind={knownTarget.kind} />}
            <span className="addr-target-name">{current ? current.name : "Custom URL"}</span>
            {current?.port && <span className="mono target-port">{current.port}</span>}
            <ChevronDown size={13} aria-hidden />
          </button>
        )}

        <div className={`url-field${knownTarget ? " known" : ""}`}>
          {!knownTarget && (
            <>
              <input
                ref={urlInput}
                value={value}
                list="server-suggestions"
                spellCheck={false}
                placeholder="https://api.example.com  ·  or {{baseUrl}}"
                // Mono, so the width in characters is the text's width: the path
                // then follows what was typed instead of sitting at the far end.
                style={{ width: `calc(${value ? value.length + 1 : 44}ch + 14px)` }}
                onChange={(event) => onChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") onSend();
                }}
              />
              <datalist id="server-suggestions">
                {suggestions.map((server) => (
                  <option key={server} value={server} />
                ))}
              </datalist>
            </>
          )}
          <span className="url-path" title={knownTarget ? `${knownTarget.url}${op.path}` : op.path}>
            <PathText path={op.path} />
          </span>
          {unverified && (
            <button
              className="tag unverified"
              onClick={onOpenConnection}
              title="Certificate verification is off for this host. Click to review."
            >
              <ShieldAlert size={10} /> unverified
            </button>
          )}
          {/* A URL you typed is a perfectly good target. This just makes keeping it
              a single click, so ad-hoc testing doesn't require setting anything up. */}
          {!knownTarget && !malformed && value.trim() !== "" && (
            <button
              className="icon-btn tight save-target"
              title="Save as an environment variable"
              aria-label="Save this base URL"
              onClick={() => onSaveTarget(resolved)}
            >
              <BookmarkPlus size={13} />
            </button>
          )}
        </div>
      </div>

      <span className="send-split">
        <button className="btn primary send" disabled={blocked} onClick={onSend} title={`Send (${shortcut("↵")})`}>
          {sending ? <Loader2 size={13} className="spin" /> : <Send size={13} />}
          {sending ? "Sending…" : "Send"}
          <span className="kbd">{shortcut("↵")}</span>
        </button>
        {(onCopyCurl || onAddToCollection) && (
          <button
            ref={sendMore}
            className="btn primary send-more"
            aria-label="More ways to send"
            aria-haspopup="menu"
            aria-expanded={Boolean(sendMenu)}
            onClick={() => {
              const rect = sendMore.current?.getBoundingClientRect();
              if (rect) setSendMenu({ x: rect.right - 240, y: rect.bottom + 4 });
            }}
          >
            <ChevronDown size={14} />
          </button>
        )}
      </span>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} label="Target" onClose={() => setMenu(null)} />}
      {sendMenu && (
        <ContextMenu
          x={sendMenu.x}
          y={sendMenu.y}
          label="Send"
          onClose={() => setSendMenu(null)}
          items={[
            ...(onCopyCurl
              ? [
                  {
                    label: "Copy as cURL",
                    hint: copyCurlShortcutLabel(isMac),
                    onSelect: () => {
                      setSendMenu(null);
                      void onCopyCurl().then((ok) => {
                        if (!ok) return;
                        setCopied(true);
                        window.setTimeout(() => setCopied(false), 2000);
                      });
                    },
                  },
                ]
              : []),
            ...(onAddToCollection
              ? [
                  {
                    label: "Add to collection…",
                    onSelect: () => {
                      const position = sendMenu;
                      setSendMenu(null);
                      onAddToCollection(position);
                    },
                  },
                ]
              : []),
          ]}
        />
      )}
      {copied && (
        <div className="urlbar-note resolved" role="status">
          Copied the request as a cURL command.
        </div>
      )}

      {envSkew && missing.length === 0 && !malformed && (
        <div className="urlbar-note">
          <TriangleAlert size={12} />
          {envSkew.name} runs {envSkew.live}; this spec is {envSkew.held}
        </div>
      )}

      {(missing.length > 0 || malformed) && (
        <div className="urlbar-note">
          <TriangleAlert size={12} />
          {missing.length > 0
            ? `undefined in this environment: ${missing.map((name) => `{{${name}}}`).join(" ")}`
            : "base URL needs http:// or https://"}
        </div>
      )}
      {value !== resolved && missing.length === 0 && !malformed && (
        <div className="urlbar-note resolved">
          → {resolved}
          {op.path}
        </div>
      )}
    </div>
  );
}

/** The target the address bar's base URL names, matched as written. */
function targetFor(targets: Target[], value: string): Target | undefined {
  const url = value.trim().replace(/\/$/, "");
  if (!url) return undefined;
  return targets.find((target) => target.url.replace(/\/$/, "") === url);
}

/** A target's name for the picker: "Local mock" and its port, "Hosted mock", an environment, or a server's host. */
export function targetLabel(target: Target): { name: string; port?: string } {
  switch (target.kind) {
    case "local-mock": {
      const port = /:(\d+)\/?$/.exec(target.url)?.[1];
      return { name: "Local mock", ...(port ? { port: `:${port}` } : {}) };
    }
    case "mock":
      return { name: "Hosted mock" };
    default:
      return { name: target.label };
  }
}

function TargetDot({ kind }: { kind: Target["kind"] }) {
  if (kind === "local-mock" || kind === "mock") return <span className="dot live" aria-hidden />;
  if (kind === "env") return <span className="dot env" aria-hidden />;
  return <span className="dot none" aria-hidden />;
}

/** The operation's path, with its `{params}` picked out. */
function PathText({ path }: { path: string }) {
  return (
    <>
      {path.split(/(\{[^}]+\})/).map((part, index) =>
        part.startsWith("{") ? (
          <span key={index} className="path-param">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}
