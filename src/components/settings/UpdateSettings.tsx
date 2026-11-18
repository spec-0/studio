import { ExternalLink, RefreshCw } from "lucide-react";
import { RELEASES_PAGE } from "../../lib/appUpdates";
import { inTauri } from "../../lib/request";
import { openInBrowser } from "../../lib/store";
import type { Updater } from "../../hooks/useUpdater";

/** Updates: the version, a check on demand, and the off-by-default check at start. */
export function UpdateSettings({ updater }: { updater: Updater }) {
  const checking = updater.open && updater.phase.kind === "checking";
  return (
    <>
      <div className="rows">
        <div className="row-s">
          <div className="l">
            <b>
              Version <span className="mono">{updater.version ?? (inTauri ? "unknown" : "browser preview")}</span>
            </b>
            <span className="meta">Every update is signed, and Studio refuses one whose signature doesn&apos;t match.</span>
          </div>
          <div className="c">
            <button className="btn ghost" onClick={() => void openInBrowser(RELEASES_PAGE)}>
              Release notes <ExternalLink size={12} />
            </button>
            <button
              className="btn"
              onClick={() => void updater.check(false)}
              disabled={!inTauri || checking}
              title={inTauri ? undefined : "Updates need the desktop app"}
            >
              <RefreshCw size={13} className={checking ? "spin" : undefined} /> Check now
            </button>
          </div>
        </div>
        <div className="row-s">
          <div className="l">
            <b>Check when Studio starts</b>
            <span className="meta">Off unless you turn it on.</span>
          </div>
          <div className="c">
            <input
              type="checkbox"
              className="switch"
              role="switch"
              aria-label="Check for updates when Studio starts"
              checked={updater.prefs.checkOnStart}
              onChange={(event) => updater.setCheckOnStart(event.target.checked)}
            />
          </div>
        </div>
      </div>
      <p className="meta settings-note">
        A check sends one request to github.com for the latest release. It carries nothing about your specs,
        environments or history, and it uses the proxy from Network settings.
      </p>
    </>
  );
}
