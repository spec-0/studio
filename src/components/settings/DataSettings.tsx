import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { describeSecretStorage, secrets } from "../../lib/secrets";
import { storeLocation } from "../../lib/store";
import { plural } from "../../lib/plural";

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
      <div className="rows">
        <div className="row-s">
          <div className="l">
            <b>History</b>
            <span className="meta">
              {plural(historyCount, "request")}, kept for 30 days on this computer with what came back and the check
              result. Never synced anywhere.
            </span>
          </div>
          <div className="c">
            {confirming ? (
              <>
                <span className="meta">This can&apos;t be undone.</span>
                <button className="btn sm" onClick={() => setConfirming(false)}>
                  Cancel
                </button>
                <button
                  className="btn sm danger-outline"
                  onClick={() => {
                    onClearHistory();
                    setConfirming(false);
                  }}
                >
                  Clear history
                </button>
              </>
            ) : (
              <button className="btn danger-outline" disabled={historyCount === 0} onClick={() => setConfirming(true)}>
                Clear history…
              </button>
            )}
          </div>
        </div>
        <div className="row-s">
          <div className="l">
            <b>Secrets</b>
            <span className="meta">
              {storage.where} Auth values aren&apos;t stored per API; they go in an environment as secret variables,
              and the environment file only notes that a secret exists, so it&apos;s safe to commit.
            </span>
          </div>
        </div>
        {storage.notice && (
          <div className="row-s stack">
            <div className="verdict warn" role="status" style={{ display: "block", lineHeight: 1.6, margin: 0 }}>
              <TriangleAlert size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />
              {storage.notice.text}
              {storage.notice.fix && <div style={{ marginTop: 4 }}>{storage.notice.fix}</div>}
            </div>
          </div>
        )}
        <div className="row-s">
          <div className="l">
            <b>Library and settings</b>
            <span className="meta">
              Your library, environments, history and settings, open request tabs and unsent changes are kept in{" "}
              <span className="mono">{location ?? "…"}</span>, with secret values written as{" "}
              <span className="mono">{"{{references}}"}</span>. An auth value typed straight into a request is kept
              only until Studio quits.
            </span>
          </div>
        </div>
      </div>
      <p className="meta settings-note">
        No telemetry, analytics or crash reporting. Studio makes no request you didn&apos;t ask for.
      </p>
    </>
  );
}
