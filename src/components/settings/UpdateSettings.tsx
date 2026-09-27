import { RefreshCw } from "lucide-react";
import { RELEASES_PAGE } from "../../lib/appUpdates";
import { inTauri } from "../../lib/request";
import { openInBrowser } from "../../lib/store";
import type { Updater } from "../../hooks/useUpdater";

/** Updates: the version, a check on demand, and the off-by-default check at start. */
export function UpdateSettings({ updater }: { updater: Updater }) {
  const checking = updater.open && updater.phase.kind === "checking";
  return (
    <>
      <dl className="settings-facts">
        <dt>Version</dt>
        <dd className="mono">{updater.version ?? (inTauri ? "unknown" : "browser preview")}</dd>
      </dl>
      <div className="settings-actions">
        <button
          className="btn primary"
          onClick={() => void updater.check(false)}
          disabled={!inTauri || checking}
          title={inTauri ? undefined : "Updates need the desktop app"}
        >
          <RefreshCw size={13} className={checking ? "spin" : undefined} /> Check for updates now
        </button>
        <button className="btn" onClick={() => void openInBrowser(RELEASES_PAGE)}>
          Open releases page
        </button>
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={updater.prefs.checkOnStart}
          onChange={(event) => updater.setCheckOnStart(event.target.checked)}
        />
        Check for updates when Studio starts (off by default)
      </label>
      <p className="field-meta">
        A check sends one request to github.com for the latest release. It carries nothing about
        your specs, environments or history, and it uses the proxy from Network settings. Every
        update is signed, and Studio refuses one whose signature doesn&apos;t match.
      </p>
    </>
  );
}
