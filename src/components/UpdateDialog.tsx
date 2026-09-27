import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  DEFAULT_UPDATE_PREFS,
  RELEASES_PAGE,
  checkForUpdate,
  currentVersion,
  describeProgress,
  installUpdate,
  loadUpdatePrefs,
  onCheckRequested,
  onUpdateProgress,
  saveUpdatePrefs,
  type AvailableUpdate,
  type UpdatePrefs,
  type UpdateProgress,
} from "../lib/appUpdates";
import { loadConnection } from "../lib/connection";
import { inTauri } from "../lib/request";
import { openExternal } from "../lib/store";

type Phase =
  | { kind: "checking" }
  | { kind: "current" }
  | { kind: "available"; update: AvailableUpdate }
  | { kind: "installing"; update: AvailableUpdate }
  | { kind: "error"; message: string };

/**
 * "Check for Updates…" — the dialog, and the optional check at start.
 *
 * Renders nothing until the menu item is picked, or until a check at start
 * (only if the user turned that on) finds a newer version. A check at start
 * that finds nothing, or fails, stays silent: nobody asked to see it.
 */
export function Updater() {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  const [prefs, setPrefs] = useState<UpdatePrefs>(DEFAULT_UPDATE_PREFS);
  const [version, setVersion] = useState<string | null>(null);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  // Only the most recent check may change what the dialog shows.
  const latest = useRef(0);

  const check = useCallback(async (quiet: boolean) => {
    const id = ++latest.current;
    if (!quiet) {
      setOpen(true);
      setPhase({ kind: "checking" });
    }
    try {
      const update = await checkForUpdate(await loadConnection());
      if (id !== latest.current) return;
      if (update) {
        setPhase({ kind: "available", update });
        setOpen(true);
      } else if (!quiet) {
        setPhase({ kind: "current" });
      }
    } catch (error) {
      if (!quiet && id === latest.current) {
        setPhase({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      }
    }
  }, []);

  useEffect(() => {
    if (!inTauri) return;
    let stopped = false;
    const unlisten: Array<() => void> = [];
    void onCheckRequested(() => void check(false)).then((stop) =>
      stopped ? stop() : unlisten.push(stop),
    );
    void onUpdateProgress(setProgress).then((stop) => (stopped ? stop() : unlisten.push(stop)));
    void currentVersion().then(setVersion);
    void loadUpdatePrefs().then((loaded) => {
      if (stopped) return;
      setPrefs(loaded);
      if (loaded.checkOnStart) void check(true);
    });
    return () => {
      stopped = true;
      unlisten.forEach((stop) => stop());
    };
  }, [check]);

  const setCheckOnStart = (checkOnStart: boolean) => {
    const next = { ...prefs, checkOnStart };
    setPrefs(next);
    void saveUpdatePrefs(next);
  };

  const install = async (update: AvailableUpdate) => {
    setProgress(null);
    setPhase({ kind: "installing", update });
    try {
      await installUpdate(); // relaunches on success, so this rarely returns
    } catch (error) {
      setPhase({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  if (!open) return null;
  const installing = phase.kind === "installing";
  const close = () => {
    if (!installing) setOpen(false);
  };

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
            about your specs, environments or history, and it uses the proxy from Connection
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
          <button className="btn" onClick={() => void openExternal(RELEASES_PAGE)}>
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
