import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { EnvironmentDraft, ImportSummary } from "../../lib/postman";

interface Props {
  summary: ImportSummary;
  environment: EnvironmentDraft | null;
  /** Close, with the environment to create (null for none). */
  onDone: (environment: EnvironmentDraft | null) => void;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * What a Postman import did: how many requests matched a spec and which
 * didn't, what happened to scripts, and whether to turn the collection's
 * variables into an environment. The collection is already imported; the
 * environment is the one choice left.
 */
export function ImportSummaryDialog({ summary, environment, onDone }: Props) {
  const [createEnv, setCreateEnv] = useState(true);
  const [withSecrets, setWithSecrets] = useState(true);
  const done = useRef<HTMLButtonElement>(null);
  useEffect(() => done.current?.focus(), []);

  const linked = summary.linked.reduce((sum, api) => sum + api.count, 0);
  const secrets = environment?.variables.filter((v) => v.secret && v.value) ?? [];

  const finish = () => {
    if (!environment || !createEnv) return onDone(null);
    onDone({
      ...environment,
      variables: environment.variables.map((v) => (v.secret && !withSecrets ? { ...v, value: "" } : v)),
    });
  };

  return (
    <div className="scrim" onClick={finish}>
      <div
        className="modal import-summary"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-summary-title"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            finish();
          }
        }}
      >
        <div className="modal-head">
          <strong id="import-summary-title">Imported {summary.name}</strong>
          <span className="spacer" />
          <button type="button" className="icon-btn tight" onClick={finish} aria-label="Close">
            <X size={15} />
          </button>
        </div>
        <div className="modal-body">
          <p className="import-headline">
            {plural(summary.requests, "request")} from Postman: <strong>{linked} linked to a spec</strong>
            {summary.notInSpec.length ? (
              <>
                , <strong>{summary.notInSpec.length} not in any spec</strong>
              </>
            ) : null}
            .
          </p>

          {summary.linked.length > 0 && (
            <section className="import-section" aria-label="Linked to a spec">
              <h3>Linked to a spec</h3>
              <p className="field-meta">These steps are checked against their spec when they run.</p>
              <ul className="import-list">
                {summary.linked.map((api) => (
                  <li key={api.api}>
                    <span>{api.api}</span>
                    <span className="meta">{plural(api.count, "step")}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {summary.notInSpec.length > 0 && (
            <section className="import-section" aria-label="Not in any spec">
              <h3>Not in any spec</h3>
              <p className="field-meta">
                Kept as plain requests. They run, but nothing checks their responses. Add the API to your library and
                use <strong>Link to an operation…</strong> on the step.
              </p>
              <ul className="import-list">
                {summary.notInSpec.map((item) => (
                  <li key={item.key} title={item.reason}>
                    <span className="mono import-request">{item.label}</span>
                    <span className="meta import-reason">{item.reason}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {(summary.scripts > 0 || summary.unchained.length > 0) && (
            <section className="import-section" aria-label="Scripts">
              <h3>Scripts</h3>
              <p className="field-meta">
                {summary.scripts > 0
                  ? `${plural(summary.scripts, "request")} had Postman scripts. Studio doesn't run scripts; each step's note says what it had.`
                  : "Studio doesn't run scripts."}
              </p>
              <ul className="import-bullets">
                {summary.statuses.length > 0 && (
                  <li>
                    {plural(summary.statuses.length, "status check")} became the step's expected status (
                    {summary.statuses.map((s) => s.status).join(", ")}).
                  </li>
                )}
                {summary.chained.map((c) => (
                  <li key={c.variable}>
                    <code>{`{{${c.variable}}}`}</code> now comes from an earlier step: <code>{c.reference}</code>
                  </li>
                ))}
                {summary.unchained.map((u) => (
                  <li key={u.variable}>
                    <code>{`{{${u.variable}}}`}</code> stays a variable ({u.reason}). Set it in an environment, or pick
                    the value from an earlier step.
                  </li>
                ))}
              </ul>
            </section>
          )}

          {summary.warnings.length > 0 && (
            <section className="import-section" aria-label="Also worth knowing">
              <h3>Also worth knowing</h3>
              <ul className="import-bullets">
                {summary.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </section>
          )}

          {environment && (
            <section className="import-section" aria-label="Variables">
              <h3>Variables</h3>
              <label className="history-check">
                <input type="checkbox" checked={createEnv} onChange={(event) => setCreateEnv(event.target.checked)} />
                Create an environment “{environment.name}” with {plural(environment.variables.length, "variable")}, and
                use it
              </label>
              <ul className="import-vars">
                {environment.variables.map((v) => (
                  <li key={v.name}>
                    <code>{v.name}</code>
                    {v.secret && <span className="tag">secret</span>}
                  </li>
                ))}
              </ul>
              {secrets.length > 0 && (
                <>
                  <label className="history-check">
                    <input
                      type="checkbox"
                      checked={withSecrets && createEnv}
                      disabled={!createEnv}
                      onChange={(event) => setWithSecrets(event.target.checked)}
                    />
                    Include the {plural(secrets.length, "secret value")} from the Postman collection
                  </label>
                  <p className="field-meta">
                    {withSecrets
                      ? "Secret values are kept like any secret variable, in your system's credential store where there is one. They are never written to the collection."
                      : "The secret variables are created empty. Fill them in under Environments."}
                  </p>
                </>
              )}
              {!createEnv && (
                <p className="field-meta">
                  The steps still refer to these as {"{{variables}}"}. Set them in an environment before running.
                </p>
              )}
            </section>
          )}
        </div>
        <div className="modal-foot">
          <span className="field-meta">The collection is in the list on the left.</span>
          <span className="spacer" />
          <button ref={done} type="button" className="btn primary" onClick={finish}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
