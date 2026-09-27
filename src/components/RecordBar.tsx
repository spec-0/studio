import { relativeTime, type HistoryEntry } from "../lib/history";

interface Props {
  entry: HistoryEntry;
  onDismiss: () => void;
}

/**
 * Says plainly that these panes are a record, not a live result.
 *
 * Without it a replayed 200 from three weeks ago is indistinguishable from one
 * just sent, and the request fields — restored from what was recorded — look
 * like values the developer typed. Sending, or picking another operation,
 * clears it.
 */
export function RecordBar({ entry, onDismiss }: Props) {
  return (
    <div className="record-bar" role="status">
      <span className="record-bar-dot" aria-hidden="true" />
      <span className="record-bar-text">
        Showing a recorded request from{" "}
        <strong>{relativeTime(entry.at)}</strong> — returned{" "}
        <strong>{entry.status}</strong> in {entry.ms}ms
        {entry.mock ? " from a mock" : ""}. Send to run it again.
      </span>
      <button className="record-bar-close" onClick={onDismiss} aria-label="Dismiss" title="Dismiss">
        ×
      </button>
    </div>
  );
}
