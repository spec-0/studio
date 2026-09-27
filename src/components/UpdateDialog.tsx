import { X } from "lucide-react";
import { RELEASES_PAGE, describeProgress } from "../lib/appUpdates";
import { openInBrowser } from "../lib/store";
import type { Updater } from "../hooks/useUpdater";

/**
 * "Check for Updates…" — the dialog.
 *
 * Renders nothing until a check is asked for (from the menu, or from Settings),
 * or until a check at start (only if the user turned that on) finds a newer
 * version. The state is in `useUpdater`, which Settings shares.
 */
export function UpdateDialog({ updater }: { updater: Updater }) {
  const { open, phase, prefs, version, progress, check, install, setCheckOnStart, close } = updater;
  if (!open) return null;
  const installing = phase.kind === "installing";

  return (
    <div className="scrim" onClick={close}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <strong>Updates</strong>
          <span className="spacer" />
          <button className="icon-btn tight" onClick={close} disabled={installing} aria-label="Close">
            <X size={15} />
          </button>
        </div>

        <div className="modal-body">
          {phase.kind === "checking" && <p>Checking GitHub for a newer version…</p>}

          {phase.kind === "current" && (
            <p>You have the latest version{version ? `, ${version}` : ""}.</p>
          )}

          {(phase.kind === "available" || phase.kind === "installing") && (
            <>
              <p>
                <strong>Version {phase.update.version}</strong> is available. You have{" "}
                {phase.update.currentVersion}.
              </p>
              {phase.update.notes?.trim() && (
                <pre className="update-notes">{phase.update.notes.trim()}</pre>
              )}
              {installing && (
                <p className="field-meta">
                  Downloading and installing{progress ? ` — ${describeProgress(progress)}` : "…"}{" "}
                  Studio will restart when it's done.
                </p>
              )}
            </>
          )}

          {phase.kind === "error" && (
            <>
              <p>Couldn't check for updates.</p>
              <div className="error-box">{phase.message}</div>
            </>
          )}

          <p className="field-meta" style={{ marginTop: 12 }}>
            A check sends one request to github.com for the latest release. It carries nothing
            about your specs, environments or history, and it uses the proxy from Network
            settings.
          </p>

          <label className="check">
            <input
              type="checkbox"
              checked={prefs.checkOnStart}
              onChange={(event) => setCheckOnStart(event.target.checked)}
            />
            Check for updates when Studio starts (off by default)
          </label>
        </div>

        <div className="modal-foot">
          <button className="btn" onClick={() => void openInBrowser(RELEASES_PAGE)}>
            Open releases page
          </button>
          <span className="spacer" style={{ flex: 1 }} />
          {phase.kind === "available" ? (
            <>
              <button className="btn" onClick={close}>
                Not now
              </button>
              <button className="btn primary" onClick={() => void install(phase.update)}>
                Install and Relaunch
              </button>
            </>
          ) : (
            <>
              {phase.kind === "error" && (
                <button className="btn" onClick={() => void check(false)}>
                  Try again
                </button>
              )}
              <button className="btn primary" onClick={close} disabled={installing}>
                {installing ? "Installing…" : "Done"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
