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
 * Start or stop the local mock for one API. While it runs, shows its address
 * with a live dot, so it's clear something on this computer is listening.
 */
export function LocalMockControl({ port, busy, error, onStart, onStop, compact = false }: Props) {
  if (port !== null) {
    return (
      <span
        className={`local-mock-live${compact ? " compact" : ""}`}
        title={`A local mock of this API is running at http://127.0.0.1:${port}, on this computer only`}
      >
        <span className="live-dot" aria-hidden />
        <span className="local-mock-address">127.0.0.1:{port}</span>
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
        {busy ? <Loader2 size={compact ? 12 : 13} className="spin" /> : <Laptop size={compact ? 12 : 13} />} Local mock
      </button>
      {error && (
        <span className="local-mock-error" role="alert" title={error}>
          {error}
        </span>
      )}
    </>
  );
}
