import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { describeSecretStorage, secrets } from "../../lib/secrets";
import { storeLocation } from "../../lib/store";

interface Props {
  /** How many requests history holds right now. */
  historyCount: number;
  onClearHistory: () => void;
}

/** Data & privacy: what Studio keeps, where, and how to clear it. */
export function DataSettings({ historyCount, onClearHistory }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [location, setLocation] = useState<string | null>(null);
  const [storage] = useState(() => describeSecretStorage(secrets.status()));

  useEffect(() => {
    void storeLocation().then(setLocation);
  }, []);

  return (
    <>
      <section className="section">
        <h3>History</h3>
        <p className="settings-lead">
          Every request you send is kept for 30 days, only on this machine, with what came back and
          the check result. History is never synced anywhere.
        </p>
        <div className="settings-actions">
          <span className="meta">
            {historyCount === 1 ? "1 request recorded" : `${historyCount} requests recorded`}
          </span>
          <span className="spacer" />
          {confirming ? (
            <>
              <span className="field-meta">Delete all history? This can&apos;t be undone.</span>
              <button className="btn" onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button
                className="btn danger-outline"
                onClick={() => {
                  onClearHistory();
                  setConfirming(false);
                }}
              >
                Clear history
              </button>
            </>
          ) : (
            <button className="btn" disabled={historyCount === 0} onClick={() => setConfirming(true)}>
              Clear history…
            </button>
          )}
        </div>
      </section>

      <section className="section">
        <h3>Secrets</h3>
        <p className="settings-lead">{storage.where}</p>
        {storage.notice && (
          <div className="verdict warn" role="status" style={{ display: "block", lineHeight: 1.6 }}>
            <TriangleAlert size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />
            {storage.notice.text}
            {storage.notice.fix && <div style={{ marginTop: 4 }}>{storage.notice.fix}</div>}
          </div>
        )}
        <p className="field-meta">
          Auth values aren&apos;t stored per API. They go in an environment as secret variables, and
          the environment file only notes that a secret exists, so it&apos;s safe to commit.
        </p>
      </section>

      <section className="section">
        <h3>On this machine</h3>
        <p className="settings-lead">
          Your library, environments, history and settings are kept in{" "}
          <span className="mono">{location ?? "…"}</span>. So are your open request tabs and
          unsent changes, with secret values written as <code>{"{{references}}"}</code>; an auth
          value typed straight into a request is kept only until Studio quits.
        </p>
        <p className="field-meta">
          No telemetry, analytics or crash reporting. Studio makes no request you didn&apos;t ask
          for.
        </p>
      </section>
    </>
  );
}
