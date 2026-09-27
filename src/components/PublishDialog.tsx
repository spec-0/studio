/**
 * Publish this document to spec0.
 *
 * Three fields and no cleverness. The name and version are pre-filled from the
 * document because the document already answered both questions, and both stay
 * editable because a value Studio chose is not a value anyone decided.
 *
 * Nothing here bumps a version. `info.version` is what the platform falls
 * through to anyway; putting an incremented number in the box would be Studio
 * making a release decision on someone's behalf and hiding it inside a default.
 */

import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Upload, X } from "lucide-react";
import {
  buildPublishRequest,
  describeResult,
  deriveApiName,
  validateApiName,
  type PublishResult,
} from "../lib/publish";
import type { GitInfo } from "../lib/git";
import type { TeamSummary } from "../lib/spec0";

interface Props {
  /** False when there's no session — a state, not an error. */
  signedIn: boolean;
  onSignIn: () => void;
  title: string;
  version: string;
  /** What gets published: the document as OpenAPI 3 text. */
  text: string;
  /** Set when the file was converted on opening, e.g. "Swagger 2.0". */
  convertedFrom?: string;
  git: GitInfo | null;
  teams: TeamSummary[];
  teamsError: string | null;
  busy: boolean;
  result: PublishResult | null;
  error: string | null;
  onPublish: (body: ReturnType<typeof buildPublishRequest>) => void;
  onOpenPublished: (apiId: string) => void;
  onClose: () => void;
}

export function PublishDialog({
  signedIn,
  onSignIn,
  title,
  version,
  text,
  convertedFrom,
  git,
  teams,
  teamsError,
  busy,
  result,
  error,
  onPublish,
  onOpenPublished,
  onClose,
}: Props) {
  const [name, setName] = useState(() => deriveApiName(title));
  const [team, setTeam] = useState("");
  const [tag, setTag] = useState(version ?? "");

  // Re-derive when the dialog is opened against a different document.
  useEffect(() => {
    setName(deriveApiName(title));
    setTag(version ?? "");
  }, [title, version]);

  const nameError = useMemo(() => validateApiName(name), [name]);
  const outcome = result ? describeResult(result) : null;

  const submit = () => {
    if (nameError || busy) return;
    onPublish(buildPublishRequest({ text, name, team, version: tag, git }));
  };

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <strong>Publish to spec0</strong>
          <span className="spacer" />
          <button className="icon-btn tight" onClick={onClose} aria-label="Close">
            <X size={15} />
          </button>
        </div>

        <div className="modal-body">
          {!signedIn ? (
            /* Being signed out is a state with a way forward, not a failure —
               and saying it here beats dropping someone on a dialog titled
               "Open a spec" with no explanation of why they arrived. */
            <>
              <p>
                Publishing sends this document to your organisation on spec0, so it needs an
                account. Everything else in Studio — this spec, its operations, your environments
                and history — keeps working without one.
              </p>
              <button className="btn primary" style={{ marginTop: 14 }} onClick={onSignIn}>
                Sign in to spec0
              </button>
            </>
          ) : outcome ? (
            <>
              <div className={`verdict ${outcome.tone === "ok" ? "none" : "warn"}`}>
                <span className="glyph">{outcome.tone === "ok" ? "✓" : "!"}</span>
                <span>{outcome.lines[0]}</span>
              </div>
              {outcome.lines.slice(1).map((line) => (
                <p className="meta" key={line} style={{ marginTop: 8 }}>
                  {line}
                </p>
              ))}
              {result?.apiId && (
                <button
                  className="btn"
                  style={{ marginTop: 14 }}
                  onClick={() => onOpenPublished(result.apiId!)}
                >
                  Open on spec0 <ExternalLink size={12} />
                </button>
              )}
            </>
          ) : (
            <>
              <label className="field">
                <span>API name</span>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value.trim())}
                  placeholder="orders-api"
                  spellCheck={false}
                  autoFocus
                />
                <span className="meta">
                  {nameError ?? "Existing API with this name in the org? This publishes a new version of it."}
                </span>
              </label>

              <label className="field">
                <span>Team</span>
                <select value={team} onChange={(event) => setTeam(event.target.value)}>
                  <option value="">Unassigned APIs</option>
                  {teams.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name}
                    </option>
                  ))}
                </select>
                <span className="meta">
                  {teamsError ?? "Where the API lives. Leave it unassigned to decide later."}
                </span>
              </label>

              <label className="field">
                <span>Version</span>
                <input
                  value={tag}
                  onChange={(event) => setTag(event.target.value)}
                  placeholder="1.0.0"
                  spellCheck={false}
                />
                <span className="meta">
                  From <code>info.version</code> in this document. Any tag works — semver, a date, a
                  build id.
                </span>
              </label>

              {/* Spec0 takes OpenAPI 3.0 and 3.1, so a converted spec is
                  published as the conversion, and the dialog says so. */}
              {convertedFrom && (
                <p className="meta" style={{ marginTop: 4 }}>
                  This file is {convertedFrom}. Spec0 accepts OpenAPI 3.0 and 3.1, so Studio publishes
                  the OpenAPI 3.0 version it converted when the file was opened, not the file itself.
                </p>
              )}

              {/* Said here rather than discovered afterwards: a dirty file is
                  published as it stands on disk, and the commit id is withheld
                  because it no longer describes these bytes. */}
              {git?.dirty && (
                <div className="verdict warn" style={{ marginTop: 4 }}>
                  <span className="glyph">!</span>
                  <span>
                    {git.path} has uncommitted changes. What you see is what gets published, and the
                    commit id isn't sent with it.
                  </span>
                </div>
              )}

              {error && (
                <div className="error-box" style={{ marginTop: 12 }}>
                  <div className="error-head">spec0 declined this publish</div>
                  <pre className="error-detail">{error}</pre>
                </div>
              )}
            </>
          )}
        </div>

        <div className="modal-foot">
          <span className="meta">
            {outcome || !signedIn ? "" : `${(text.length / 1024).toFixed(0)} KB · ${title || "untitled"}`}
          </span>
          <span className="spacer" />
          {!signedIn ? (
            <button className="btn" onClick={onClose}>
              Close
            </button>
          ) : outcome ? (
            <button className="btn primary" onClick={onClose}>
              Done
            </button>
          ) : (
            <>
              <button className="btn" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button className="btn primary" onClick={submit} disabled={Boolean(nameError) || busy}>
                <Upload size={13} /> {busy ? "Publishing…" : "Publish"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
