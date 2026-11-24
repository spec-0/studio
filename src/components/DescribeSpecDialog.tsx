import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { describeSpec, hostsOf, type DescribedSpec, type Sample } from "../lib/describeSpec";
import { plural } from "../lib/plural";
import { inTauri } from "../lib/request";
import { CodeBlock } from "./CodeBlock";
import { Dialog } from "./Dialog";

interface Props {
  samples: Sample[];
  /** Where it was started: the scratch screen, or a collection (by name), whose steps get linked. */
  collectionName?: string;
  onClose: () => void;
  /** Save the file and add it to the library. Resolves false when the save dialog was cancelled. */
  onSave: (described: DescribedSpec, host: string) => Promise<boolean>;
}

/**
 * Describe as a spec: pick a host, see the operations Studio will write and
 * the YAML, then save it. The document is built here from what History
 * already holds; nothing is sent.
 */
export function DescribeSpecDialog({ samples, collectionName, onClose, onSave }: Props) {
  const hosts = useMemo(() => hostsOf(samples), [samples]);
  const [origin, setOrigin] = useState(hosts[0]?.origin ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const described = useMemo(() => (origin ? describeSpec(samples, origin) : null), [samples, origin]);
  const host = hosts.find((h) => h.origin === origin);

  const save = async () => {
    if (!described || !host || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (await onSave(described, host.host)) onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Describe as a spec"
      subtitle={
        collectionName
          ? `From the steps in ${collectionName} that aren't in a spec`
          : "From your scratch requests in History"
      }
      wide
      top
      busy={busy}
      className="describe-spec"
      labelId="describe-spec-title"
      onClose={onClose}
      onConfirm={described ? () => void save() : undefined}
      footerContext={
        described
          ? collectionName
            ? "Saved as a file in your library. The steps are then linked to it."
            : "Saved as a file in your library, to edit like any spec."
          : undefined
      }
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={() => void save()} disabled={!described || busy}>
            {busy && <Loader2 size={13} className="spin" />}
            {inTauri ? "Save…" : "Download and add"}
          </button>
        </>
      }
    >
      {!described || !host ? (
        <p className="meta">
          {collectionName
            ? "None of this collection's steps that aren't in a spec has a URL Studio can read."
            : "Nothing to describe yet. Send a scratch request first; Studio writes the spec from what came back."}
        </p>
      ) : (
        <div className="describe-body">
          <p className="describe-lead">
            A draft OpenAPI 3.1 document from {plural(host.count, "request")} to <strong>{host.host}</strong>, built from
            what History recorded. Nothing is sent. Read it through before you rely on it.
          </p>

          {hosts.length > 1 && (
            <label className="field">
              <span>Host</span>
              <select value={origin} onChange={(event) => setOrigin(event.target.value)} disabled={busy}>
                {hosts.map((h) => (
                  <option key={h.origin} value={h.origin}>
                    {h.host} ({plural(h.count, "request")})
                  </option>
                ))}
              </select>
              <span className="meta">A spec describes one host. Describe the others one at a time.</span>
            </label>
          )}

          <section className="describe-section" aria-labelledby="describe-ops">
            <h3 id="describe-ops">{plural(described.operations.length, "operation")}</h3>
            <ul className="describe-ops">
              {described.operations.map((op) => (
                <li key={`${op.method} ${op.path}`}>
                  <span className={`method ${op.method.toLowerCase()}`}>{op.method === "DELETE" ? "DEL" : op.method}</span>
                  <span className="mono describe-path" title={op.path}>
                    {op.path}
                  </span>
                  <span className="mono meta">{op.operationId}</span>
                  <span className="meta describe-statuses">
                    {op.statuses.length ? op.statuses.join(", ") : "no response yet"}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          {described.leftOut.length > 0 && (
            <p className="field-meta">
              Left out because they carry credentials: {described.leftOut.join(", ")}.
              {(described.doc.components as { securitySchemes?: object } | undefined)?.securitySchemes
                ? " The auth they use is described, without its value."
                : ""}
            </p>
          )}

          <section className="describe-section" aria-labelledby="describe-yaml">
            <h3 id="describe-yaml">Preview</h3>
            <CodeBlock text={described.yaml} syntax="yaml" className="describe-yaml" />
          </section>

          {error && (
            <p className="verdict warn" role="alert">
              <span className="glyph">!</span>
              <span>Couldn't save it: {error}</span>
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}
