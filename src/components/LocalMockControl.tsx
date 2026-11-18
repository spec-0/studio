import { useState } from "react";
import { Laptop, Loader2, Square } from "lucide-react";

interface Props {
  /** The port while a local mock serves this API; null when it doesn't. */
  port: number | null;
  busy: boolean;
  /** Why the last start failed, if it did. */
  error?: string | null;
  onStart: () => void;
  onStop: () => void;
  /** Smaller, for a library card. */
  compact?: boolean;
}

/**
 * Start or stop the local mock for one API. While it runs, it says so in words
 * ("Local mock · Running") with a live dot, so it isn't mistaken for the MCP
 * server or any other address. The address is in the tooltip, and a click
 * copies it.
 */
export function LocalMockControl({ port, busy, error, onStart, onStop, compact = false }: Props) {
  const [copied, setCopied] = useState(false);
  if (port !== null) {
    const address = `http://127.0.0.1:${port}`;
    const copy = () => {
      void navigator.clipboard
        ?.writeText(address)
        .then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
        .catch(() => {});
    };
    return (
      <span className={`local-mock-live${compact ? " compact" : ""}`}>
        <button
          type="button"
          className="local-mock-label"
          onClick={copy}
          title={`Local mock running at ${address}, on this computer only. Click to copy the address.`}
          aria-label={`Local mock running at ${address}. Copy the address`}
        >
          <span className="dot live" aria-hidden />
          <span>Local mock</span>
          <span className="mono local-mock-port">{copied ? "copied" : `:${port}`}</span>
        </button>
        <button
          className="icon-btn tight"
          onClick={onStop}
          disabled={busy}
          aria-label={`Stop the local mock on port ${port}`}
          title="Stop the local mock"
        >
          {busy ? <Loader2 size={11} className="spin" /> : <Square size={11} />}
        </button>
      </span>
    );
  }
  return (
    <>
      <button
        className={`btn ghost${compact ? " card-mock" : ""}`}
        onClick={onStart}
        disabled={busy}
        title={error ?? "Serve this API on this computer (127.0.0.1) with example responses from the spec"}
      >
        {busy ? <Loader2 size={compact ? 12 : 13} className="spin" /> : <Laptop size={compact ? 12 : 13} />}{" "}
        <span className="lbl">{compact ? "Local mock" : "Start local mock"}</span>
      </button>
      {error && (
        <span className="local-mock-error" role="alert" title={error}>
          {error}
        </span>
      )}
    </>
  );
}
