/**
 * "Create a mock server": one dialog, one short checklist.
 *
 * Steps that are already true (signed in, one team, already on Spec0) are
 * ticked with the reason and skipped. What decides the next step lives in
 * `lib/mockJourney`; this file only draws it.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Copy, ExternalLink, Eye, EyeOff, KeyRound, Plus, RefreshCw, Send, Server, X } from "lucide-react";
import type { LibraryEntry } from "../../lib/library";
import {
  API_FEATURE,
  checklist,
  journeyAvailable,
  maskKey,
  MOCK_FEATURE,
  upfrontBlock,
  usageLine,
  type JourneyState,
  type JourneyView,
} from "../../lib/mockJourney";
import { deriveApiName, validateApiName, whyNotPublishable } from "../../lib/publish";
import { inTauri } from "../../lib/request";
import { targetOf } from "../../hooks/useMockJourney";

interface Props {
  mode: "pick" | "journey";
  state: JourneyState;
  view: JourneyView;
  orgName: string | null;
  /** For the pick list. */
  entries: LibraryEntry[];
  apiUrl: string;
  cliAvailable: boolean;
  retargeted: boolean;
  rebuildLines: string[] | null;
  onPick: (entry: LibraryEntry) => void;
  onAddApi: () => void;
  onConnect: (how: "cli" | "browser") => void;
  onChooseTeam: (teamId: string | null) => void;
  onRetryTeams: () => void;
  onPublish: (name: string, version: string) => void;
  onCreateMock: () => void;
  onSaveKey: (key: string) => void;
  onRebuild: () => void;
  onRegenerateKey: () => void;
  onSendTest: () => void;
  onOpenSpec0: () => void;
  onOpenApiOnSpec0: (() => void) | null;
  onClose: () => void;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keep Tab inside the dialog, close on Escape, and focus the first control of each step. */
function useDialogFocus(ref: React.RefObject<HTMLDivElement>, onClose: () => void, key: string) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    return () => previous?.focus?.();
  }, []);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const body = root.querySelector<HTMLElement>(".journey-main");
    const first =
      body?.querySelector<HTMLElement>("[data-autofocus]") ?? body?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? root).focus();
  }, [ref, key]);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    root.addEventListener("keydown", onKey);
    return () => root.removeEventListener("keydown", onKey);
  }, [ref]);
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="icon-btn tight"
      aria-label={label}
      title={label}
      onClick={() =>
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1400);
        })
      }
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

function Problem({
  state,
  onOpenSpec0,
}: {
  state: JourneyState;
  onOpenSpec0: () => void;
}) {
  if (state.notice && !state.error) {
    return (
      <p className="journey-notice" role="status">
        {state.notice}
      </p>
    );
  }
  const error = state.error;
  if (!error) return null;
  const warn = error.kind === "limit" || error.kind === "breaking";
  return (
    <div className={warn ? "verdict warn journey-problem" : "error-box journey-problem"} role="alert">
      {warn && <span className="glyph">!</span>}
      <div>
        <p>{error.message}</p>
        {error.kind === "limit" && (
          <button className="btn" style={{ marginTop: 8 }} onClick={onOpenSpec0}>
            Open Spec0 <ExternalLink size={12} />
          </button>
        )}
      </div>
    </div>
  );
}

export function MockJourneyDialog(props: Props) {
  const { mode, state, view, onClose } = props;
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, onClose, `${mode}:${view}`);

  const title =
    mode === "pick"
      ? "Create a mock server"
      : state.target.mock
        ? "Mock server"
        : "Create a mock server";

  return (
    <div className="scrim journey-scrim" onClick={onClose}>
      <div
        ref={ref}
        className="modal journey"
        role="dialog"
        aria-modal="true"
        aria-labelledby="journey-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <Server size={14} aria-hidden />
          <strong id="journey-title">{title}</strong>
          {mode === "journey" && <span className="meta journey-api">{state.target.title}</span>}
          <span className="spacer" />
          <button className="icon-btn tight" onClick={onClose} aria-label="Close">
            <X size={15} />
          </button>
        </div>

        {mode === "pick" ? <PickApi {...props} /> : <Journey {...props} />}
      </div>
    </div>
  );
}

function PickApi({ entries, apiUrl, onPick, onAddApi }: Props) {
  const rows = entries.map((entry) => ({ entry, target: targetOf(entry, apiUrl) }));
  const ready = rows.filter((row) => !row.target.mock && journeyAvailable(row.target));
  const hasMock = rows.filter((row) => row.target.mock);
  const other = rows.length - ready.length - hasMock.length;

  return (
    <div className="modal-body journey-main">
      <p className="journey-lead">Which API should the mock serve?</p>
      {ready.length === 0 ? (
        <div className="placeholder-card" style={{ marginTop: 12 }}>
          <Server size={18} aria-hidden />
          <div>
            <p>No API in your library can get a mock yet.</p>
            <p className="field-meta">
              Add a spec from a file, a URL or Spec0, then create its mock here.
            </p>
            <button className="btn primary" style={{ marginTop: 10 }} onClick={onAddApi}>
              <Plus size={13} /> Add API
            </button>
          </div>
        </div>
      ) : (
        <ul className="journey-pick" aria-label="APIs without a mock">
          {ready.map(({ entry, target }) => (
            <li key={entry.id}>
              <button className="row" onClick={() => onPick(entry)}>
                <span className="path">{entry.title}</span>
                {entry.version && <span className="count">{entry.version}</span>}
                <span className="spacer" />
                <span className="meta">
                  {target.apiId ? "on Spec0" : target.sourceKind === "url" ? "from a URL" : "local file"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {(hasMock.length > 0 || other > 0) && (
        <p className="field-meta" style={{ marginTop: 12 }}>
          {hasMock.length > 0 && `${hasMock.length} already ${hasMock.length === 1 ? "has" : "have"} a mock. `}
          {other > 0 &&
            "The sample API can't get a mock; it isn't a real API."}
        </p>
      )}
    </div>
  );
}

function Journey(props: Props) {
  const { state, view, orgName } = props;
  const items = useMemo(() => checklist(state, orgName), [state, orgName]);

  return (
    <div className="journey-body">
      <ol className="journey-steps" aria-label="Steps">
        {items.map((item, index) => (
          <li
            key={item.id}
            className={`journey-step ${item.status}`}
            aria-current={item.status === "current" ? "step" : undefined}
          >
            <span className="journey-dot" aria-hidden>
              {item.status === "done" || item.status === "skipped" ? <Check size={11} /> : index + 1}
            </span>
            <span className="journey-step-text">
              <span>{item.label}</span>
              {item.note && <span className="field-meta">{item.note}</span>}
              <span className="sr-only">
                {item.status === "current" ? " (current step)" : item.status === "todo" ? "" : ` (${item.status})`}
              </span>
            </span>
          </li>
        ))}
      </ol>

      <div className="journey-main" aria-live="polite">
        {view === "signIn" && <SignInStep {...props} />}
        {view === "team" && <TeamStep {...props} />}
        {view === "publish" && <PublishStep {...props} />}
        {view === "mock" && <MockStep {...props} />}
        {view === "blocked" && <BlockedStep {...props} />}
        {view === "done" && <DoneStep {...props} />}
      </div>
    </div>
  );
}

function StepHead({ children }: { children: ReactNode }) {
  return <h2 className="journey-heading">{children}</h2>;
}

function Busy({ label }: { label: string | null }) {
  return label ? (
    <p className="meta journey-busy" role="status">
      <RefreshCw size={12} className="spin" aria-hidden /> {label}
    </p>
  ) : null;
}

function SignInStep({ state, cliAvailable, onConnect, onOpenSpec0 }: Props) {
  return (
    <>
      <StepHead>Sign in to Spec0</StepHead>
      <p className="journey-lead">
        Connecting lets Studio publish this API to your organisation and host a mock for it. The rest
        of Studio works without an account.
      </p>
      <Problem state={state} onOpenSpec0={onOpenSpec0} />
      <div className="journey-actions column">
        {cliAvailable && (
          <button
            className="btn primary"
            data-autofocus
            disabled={Boolean(state.busy)}
            onClick={() => onConnect("cli")}
          >
            Use your spec0 CLI sign-in
          </button>
        )}
        <button
          className={cliAvailable ? "btn" : "btn primary"}
          disabled={Boolean(state.busy) || !inTauri}
          onClick={() => onConnect("browser")}
        >
          Sign in with a browser
        </button>
        {!inTauri && <p className="field-meta">Browser sign-in needs the desktop app.</p>}
      </div>
      <Busy label={state.busy} />
    </>
  );
}

function TeamStep({ state, onChooseTeam, onRetryTeams, onOpenSpec0 }: Props) {
  const [team, setTeam] = useState("");
  if (state.teams === null) {
    return (
      <>
        <StepHead>Choose a team</StepHead>
        {state.error ? (
          <>
            <Problem state={state} onOpenSpec0={onOpenSpec0} />
            <button className="btn" style={{ marginTop: 12 }} onClick={onRetryTeams}>
              Try again
            </button>
          </>
        ) : (
          <Busy label="Loading your teams…" />
        )}
      </>
    );
  }
  return (
    <>
      <StepHead>Choose a team</StepHead>
      <p className="journey-lead">The team that owns this API in your organisation.</p>
      <label className="journey-field">
        <span>Team</span>
        <select value={team} onChange={(event) => setTeam(event.target.value)} data-autofocus>
          <option value="">Unassigned</option>
          {state.teams.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
            </option>
          ))}
        </select>
        <span className="field-meta">You can move it to another team later in Spec0.</span>
      </label>
      <div className="journey-actions">
        <button className="btn primary" onClick={() => onChooseTeam(team || null)}>
          Continue
        </button>
      </div>
    </>
  );
}

function PublishStep({ state, onPublish, onOpenSpec0 }: Props) {
  const [name, setName] = useState(() => deriveApiName(state.target.title));
  const [version, setVersion] = useState(state.target.version ?? "");
  const nameError = validateApiName(name);
  const usage = usageLine(state.entitlements, API_FEATURE);
  const busy = Boolean(state.busy);

  return (
    <>
      <StepHead>Publish to your organisation</StepHead>
      <p className="journey-lead">
        A mock is built from a spec on Spec0, so this API goes there first. Published APIs are
        visible only inside your organisation.
      </p>
      <label className="journey-field">
        <span>API name</span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value.trim())}
          spellCheck={false}
          aria-invalid={Boolean(nameError)}
          aria-describedby="journey-name-help"
          data-autofocus
        />
        <span id="journey-name-help" className={nameError && name ? "field-meta warn" : "field-meta"}>
          {nameError ?? "Lower-case letters, digits and dashes."}
        </span>
      </label>
      <label className="journey-field">
        <span>Version</span>
        <input value={version} onChange={(event) => setVersion(event.target.value)} spellCheck={false} />
        <span className="field-meta">
          From <code>info.version</code>. Change it if Spec0 reports breaking changes.
        </span>
      </label>
      <Problem state={state} onOpenSpec0={onOpenSpec0} />
      {usage && <p className="field-meta journey-usage">{usage}</p>}
      <div className="journey-actions">
        <button
          className="btn primary"
          disabled={Boolean(nameError) || busy}
          onClick={() => onPublish(name, version)}
        >
          {busy ? "Publishing…" : "Publish"}
        </button>
      </div>
    </>
  );
}

function MockStep({ state, onCreateMock, onOpenSpec0 }: Props) {
  const usage = usageLine(state.entitlements, MOCK_FEATURE);
  const busy = Boolean(state.busy);
  return (
    <>
      <StepHead>Create the mock</StepHead>
      <p className="journey-lead">
        Spec0 hosts a mock of {state.target.title} that answers with example data generated from the spec. It has
        its own address and key; Studio keeps both for you.
      </p>
      <Problem state={state} onOpenSpec0={onOpenSpec0} />
      {usage && <p className="field-meta journey-usage">{usage}</p>}
      <div className="journey-actions">
        <button className="btn primary" disabled={busy} onClick={onCreateMock} data-autofocus>
          {busy ? "Creating…" : "Create mock"}
        </button>
      </div>
    </>
  );
}

function BlockedStep({ state, onOpenSpec0, onClose }: Props) {
  const limit = upfrontBlock(state);
  return (
    <>
      <StepHead>{limit ? "Can't create a mock right now" : "This API can't be published from here"}</StepHead>
      <div className="verdict warn journey-problem" role="alert">
        <span className="glyph">!</span>
        <span>{limit ?? whyNotPublishable({ kind: state.target.sourceKind, ref: "x" })}</span>
      </div>
      {limit && (
        <p className="journey-lead" style={{ marginTop: 10 }}>
          You can remove one you no longer need in Spec0, then come back.
        </p>
      )}
      <div className="journey-actions">
        {limit && (
          <button className="btn primary" onClick={onOpenSpec0} data-autofocus>
            Open Spec0 <ExternalLink size={12} />
          </button>
        )}
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </>
  );
}

function DoneStep({
  state,
  retargeted,
  rebuildLines,
  onSaveKey,
  onRebuild,
  onRegenerateKey,
  onSendTest,
  onOpenApiOnSpec0,
  onOpenSpec0,
}: Props) {
  const mock = state.mock!;
  const [reveal, setReveal] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [pasted, setPasted] = useState("");
  const busy = Boolean(state.busy);
  const justCreated = !state.target.mock;

  return (
    <>
      <StepHead>{justCreated ? "Your mock is ready" : `${state.target.title} has a mock`}</StepHead>

      <div className="journey-kv">
        <span className="journey-k">Address</span>
        <code className="journey-v">{mock.url}</code>
        <CopyButton value={mock.url} label="Copy the mock's address" />
      </div>

      <div className="journey-kv">
        <span className="journey-k">Key</span>
        {mock.apiKey ? (
          <>
            <code className="journey-v">{reveal ? mock.apiKey : maskKey(mock.apiKey)}</code>
            <button
              className="icon-btn tight"
              aria-label={reveal ? "Hide the key" : "Show the key"}
              title={reveal ? "Hide" : "Show"}
              onClick={() => setReveal((on) => !on)}
            >
              {reveal ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
            <CopyButton value={mock.apiKey} label="Copy the key" />
          </>
        ) : (
          <div className="journey-paste">
            <span className="field-meta">
              Studio couldn&apos;t get this key from Spec0. Paste it from the mock&apos;s page there.
            </span>
            <div className="mock-key-field">
              <KeyRound size={12} aria-hidden />
              <input
                type="password"
                aria-label="Mock key"
                value={pasted}
                placeholder="Mock key"
                onChange={(event) => setPasted(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && pasted.trim()) onSaveKey(pasted.trim());
                }}
              />
            </div>
            <button className="btn" disabled={!pasted.trim()} onClick={() => onSaveKey(pasted.trim())}>
              Save
            </button>
          </div>
        )}
      </div>
      {mock.apiKey && (
        <p className="field-meta journey-note">
          Saved on this machine and sent as <code>X-Mock-API-Key</code> when you call the mock.
        </p>
      )}
      {retargeted && (
        <p className="field-meta journey-note">
          Requests for this API now go to the mock. Switch back from the address bar.
        </p>
      )}

      <div className="journey-actions">
        <button className="btn primary" onClick={onSendTest} disabled={busy} data-autofocus>
          <Send size={12} /> Send a test request
        </button>
        <button className="btn" onClick={onRebuild} disabled={busy || !state.signedIn}>
          <RefreshCw size={12} /> Rebuild mock
        </button>
        {state.signedIn && (
          <button className="btn" onClick={() => setConfirming(true)} disabled={busy || confirming}>
            <KeyRound size={12} /> Regenerate key
          </button>
        )}
        {onOpenApiOnSpec0 && (
          <button className="btn ghost" onClick={onOpenApiOnSpec0}>
            Open in Spec0 <ExternalLink size={12} />
          </button>
        )}
      </div>
      {/* Results go below the buttons, so the buttons never move under the pointer. */}
      {confirming && (
        <div className="verdict warn journey-problem" role="alert">
          <span className="glyph">!</span>
          <div>
            <p>The current key stops working straight away, for everyone using it.</p>
            <div className="journey-actions" style={{ marginTop: 8 }}>
              <button
                className="btn primary"
                onClick={() => {
                  setConfirming(false);
                  setReveal(false);
                  onRegenerateKey();
                }}
              >
                Make a new key
              </button>
              <button className="btn" onClick={() => setConfirming(false)}>
                Keep this key
              </button>
            </div>
          </div>
        </div>
      )}

      {rebuildLines && (
        <div className="verdict none journey-problem" role="status">
          <span className="glyph">✓</span>
          <div>
            {rebuildLines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        </div>
      )}
      <Problem state={state} onOpenSpec0={onOpenSpec0} />
      <Busy label={state.busy} />

      <p className="field-meta journey-note">
        Rebuild makes the mock serve the spec as it is on Spec0 now. Its address and key stay the same.
      </p>
    </>
  );
}
