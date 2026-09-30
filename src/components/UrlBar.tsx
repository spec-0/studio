import { useMemo, useRef } from "react";
import { BookmarkPlus, CornerDownLeft, Loader2, Send, ShieldAlert, TriangleAlert } from "lucide-react";
import { interpolate, unresolved } from "../lib/env";
import type { OperationSpec } from "../lib/spec";
import type { Target } from "../lib/targets";

export type { Target };

/** Sentinel for the "type your own" option; "" would be indistinguishable from unset. */
const CUSTOM = "__custom__";

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
}: Props) {
  const urlInput = useRef<HTMLInputElement>(null);

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
  const isMock = Boolean(mockUrl && resolved.replace(/\/$/, "") === mockUrl.replace(/\/$/, ""));
  const resolvedTarget = targets.find(
    (t) => t.url.replace(/\/$/, "") === resolved.replace(/\/$/, ""),
  );
  const isKnown = Boolean(resolvedTarget);
  const malformed = value.trim() !== "" && missing.length === 0 && !/^https?:\/\//i.test(resolved);
  const blocked = sending || !value.trim() || malformed || missing.length > 0;

  return (
    <div className="urlbar">
      <span className={`method-chip ${op.method.toLowerCase()}`}>{op.method}</span>

      {/* One-click switch between the spec's servers and the hosted mock. E7 is
          explicit that a developer must never be unsure which one they just hit,
          so the mock is labelled here and tagged in the field and in history. */}
      {targets.length > 0 && (
        <select
          className="target-select"
          value={isKnown ? resolvedTarget!.url : CUSTOM}
          onChange={(event) => {
            // Picking "Custom" clears the field and puts the cursor in it. It has
            // its own sentinel value so the choice isn't mistaken for "unset".
            if (event.target.value === CUSTOM) {
              onChange("");
              requestAnimationFrame(() => urlInput.current?.focus());
              return;
            }
            onChange(event.target.value);
          }}
          title="Target"
        >
          {targets.map((target) => (
            <option key={target.url} value={target.url}>
              {target.kind === "mock" ? "◆ " : target.kind === "local-mock" ? "◇ " : target.kind === "env" ? "● " : ""}
              {target.label}
            </option>
          ))}
          <option value={CUSTOM}>Custom…</option>
        </select>
      )}

      <div className="url-field">
        <input
          ref={urlInput}
          value={value}
          list="server-suggestions"
          spellCheck={false}
          placeholder="https://api.example.com  ·  or {{baseUrl}}"
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
        <span className="url-path" title={op.path}>
          {op.path}
        </span>
        {isMock && <span className="tag mock">mock</span>}
        {resolvedTarget?.kind === "local-mock" && <span className="tag mock">local mock</span>}
        {unverified && (
          <button
            className="tag unverified"
            onClick={onOpenConnection}
            title="Certificate verification is off for this host. Click to review."
          >
            <ShieldAlert size={10} /> unverified
          </button>
        )}
        {resolvedTarget?.kind === "env" && <span className="tag env">{resolvedTarget.label}</span>}
        {/* A URL you typed is a perfectly good target. This just makes keeping it
            a single click, so ad-hoc testing doesn't require setting anything up. */}
        {!isKnown && !malformed && value.trim() !== "" && (
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

      <button className="btn primary send" disabled={blocked} onClick={onSend}>
        {sending ? (
          <Loader2 size={13} className="spin" />
        ) : (
          <Send size={13} />
        )}
        {sending ? "Sending" : "Send"}
        <span className="kbd">
          <CornerDownLeft size={9} />
        </span>
      </button>

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
