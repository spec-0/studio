import { useEffect, useState } from "react";
import { Eye, EyeOff, Lock, Plus, X } from "lucide-react";
import {
  newEnvironment,
  sharedEnvironment,
  SHARED_ID,
  type Environment,
  type EnvironmentFile,
  type Variable,
} from "../lib/env";
import { storeLocation } from "../lib/store";
import { describeSecretStorage, secrets } from "../lib/secrets";
import { Dialog } from "./Dialog";

interface Props {
  file: EnvironmentFile;
  onSave: (file: EnvironmentFile) => void;
  onClose: () => void;
}

export function EnvironmentsDialog({ file, onSave, onClose }: Props) {
  const [draft, setDraft] = useState<EnvironmentFile>(file);
  /** The environment being edited, or {@link SHARED_ID} for the shared variables. */
  const [selectedId, setSelectedId] = useState<string>(file.activeId ?? SHARED_ID);
  const [location, setLocation] = useState("");
  /** Secret values shown in the clear, by row, while the dialog is open. */
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  // Read once on open: environments have loaded by the time this can be shown.
  const [storage] = useState(() => describeSecretStorage(secrets.status()));

  useEffect(() => {
    void storeLocation().then(setLocation);
  }, []);

  const shared = sharedEnvironment(draft);
  const isShared = selectedId === SHARED_ID;
  const selected = isShared ? shared : (draft.environments.find((env) => env.id === selectedId) ?? null);
  /** Shared variables this environment doesn't set itself, so it uses them as they are. */
  const inherited =
    selected && !isShared
      ? shared.variables.filter((v) => v.name && !selected.variables.some((own) => own.name === v.name))
      : [];
  const overridden =
    selected && !isShared ? selected.variables.filter((own) => own.name && shared.variables.some((v) => v.name === own.name)) : [];

  const update = (next: Environment) =>
    setDraft((prev) =>
      next.id === SHARED_ID
        ? { ...prev, shared: next.variables }
        : { ...prev, environments: prev.environments.map((env) => (env.id === next.id ? next : env)) },
    );

  const addEnvironment = () => {
    const created = newEnvironment(`Environment ${draft.environments.length + 1}`);
    setDraft((prev) => ({
      ...prev,
      environments: [...prev.environments, created],
      activeId: prev.activeId ?? created.id,
    }));
    setSelectedId(created.id);
    setRevealed(new Set());
  };

  const select = (id: string) => {
    setSelectedId(id);
    setRevealed(new Set());
  };

  const setVariable = (index: number, patch: Partial<Variable>) => {
    if (!selected) return;
    update({
      ...selected,
      variables: selected.variables.map((variable, i) =>
        i === index ? { ...variable, ...patch } : variable,
      ),
    });
  };

  /** The add row becomes a variable once it has a name. */
  const commitNew = () => {
    if (!selected || !newName.trim()) return;
    update({ ...selected, variables: [...selected.variables, { name: newName.trim(), value: newValue, secret: false }] });
    setNewName("");
    setNewValue("");
  };
  const onNewKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || !newName.trim()) return;
    event.preventDefault();
    commitNew();
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[aria-label="New variable name"]')?.focus());
  };

  return (
    <Dialog
      title="Environments"
      subtitle={
        <>
          Values you use as <span className="mono">{"{{name}}"}</span> in URLs, parameters, headers, auth and bodies.
          Where a request goes is chosen in the address bar.
        </>
      }
      wide
      flush
      className="env-dialog"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={() => {
              onSave(draft);
              onClose();
            }}
          >
            Save
          </button>
        </>
      }
    >
      <div className="env-split">
        <div className="env-list">
          <div className="env-list-items">
            <button className="row env-row" aria-selected={isShared} onClick={() => select(SHARED_ID)}>
              <span className="env-row-name">
                Shared
                <span className="env-row-sub">Every environment</span>
              </span>
              <span className="count">{shared.variables.length}</span>
            </button>
            {draft.environments.length > 0 && <div className="env-list-label">Environments</div>}
            {draft.environments.map((env) => (
              <button
                key={env.id}
                className="row env-row"
                aria-selected={env.id === selectedId}
                onClick={() => select(env.id)}
              >
                <span className="env-row-name">{env.name || "Untitled"}</span>
                {env.id === draft.activeId ? (
                  <span className="chip sans ok">active</span>
                ) : (
                  <span className="count">{env.variables.length}</span>
                )}
              </button>
            ))}
          </div>
          <button className="btn ghost env-new" onClick={addEnvironment}>
            <Plus size={13} aria-hidden /> New environment
          </button>
        </div>

        <div className="env-detail">
          {storage.notice && (
            <div className="verdict warn" role="status" style={{ display: "block", lineHeight: 1.6 }}>
              {storage.notice.text}
              {storage.notice.fix && (
                <>
                  <br />
                  {storage.notice.fix}
                </>
              )}
              {storage.notice.details && (
                <div className="meta" style={{ marginTop: 4 }}>
                  Details: {storage.notice.details}
                </div>
              )}
            </div>
          )}
          {!selected ? null : (
            <>
              {isShared ? (
                <p className="env-intro meta">
                  Shared variables apply in every environment, and when none is chosen. Put values that are the same
                  everywhere here. An environment only needs the ones that differ, and its value wins.
                </p>
              ) : (
                <label className="field env-name">
                  <span className="field-label-text">Name</span>
                  <input className="input" value={selected.name} onChange={(event) => update({ ...selected, name: event.target.value })} />
                </label>
              )}
              <table className="tbl env-vars">
                <colgroup>
                  <col style={{ width: "34%" }} />
                  <col />
                  <col style={{ width: 64 }} />
                  <col style={{ width: 64 }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>Variable</th>
                    <th>Value</th>
                    <th>Secret</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {selected.variables.map((variable, index) => {
                    const hidden = variable.secret && !revealed.has(index);
                    return (
                      <tr key={index}>
                        <td>
                          <input
                            className="cell-input mono"
                            value={variable.name}
                            placeholder="baseUrl"
                            aria-label="Variable name"
                            onChange={(event) => setVariable(index, { name: event.target.value })}
                          />
                        </td>
                        <td>
                          <input
                            className="cell-input mono"
                            type={hidden ? "password" : "text"}
                            value={variable.value}
                            aria-label={`Value of ${variable.name || "this variable"}`}
                            onChange={(event) => setVariable(index, { value: event.target.value })}
                          />
                        </td>
                        <td>
                          <input
                            type="checkbox"
                            className="switch"
                            role="switch"
                            aria-label={`${variable.name || "This variable"} is secret`}
                            checked={variable.secret}
                            onChange={(event) => setVariable(index, { secret: event.target.checked })}
                          />
                        </td>
                        <td className="row-actions">
                          {variable.secret && (
                            <button
                              type="button"
                              className="icon-btn tight"
                              aria-label={hidden ? "Show value" : "Hide value"}
                              title={hidden ? "Show value" : "Hide value"}
                              onClick={() =>
                                setRevealed((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(index)) next.delete(index);
                                  else next.add(index);
                                  return next;
                                })
                              }
                            >
                              {hidden ? <Eye size={13} /> : <EyeOff size={13} />}
                            </button>
                          )}
                          <button
                            type="button"
                            className="icon-btn tight"
                            aria-label={`Remove ${variable.name || "this variable"}`}
                            title="Remove"
                            onClick={() => {
                              setRevealed(new Set());
                              update({ ...selected, variables: selected.variables.filter((_, i) => i !== index) });
                            }}
                          >
                            <X size={13} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr
                    onBlur={(event) => {
                      // Leaving the add row with a name in it adds the variable.
                      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                      commitNew();
                    }}
                  >
                    <td>
                      <input
                        className="cell-input mono"
                        value={newName}
                        placeholder={isShared ? "Add a shared variable" : "Add variable"}
                        aria-label="New variable name"
                        onChange={(event) => setNewName(event.target.value)}
                        onKeyDown={onNewKey}
                      />
                    </td>
                    <td>
                      <input
                        className="cell-input mono"
                        placeholder="Value"
                        aria-label="New variable value"
                        value={newValue}
                        onChange={(event) => setNewValue(event.target.value)}
                        onKeyDown={onNewKey}
                      />
                    </td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              </table>
              {!isShared && (inherited.length > 0 || overridden.length > 0) && (
                <div className="env-inherited">
                  <div className="env-inherited-head meta">
                    From shared variables
                    {overridden.length > 0 && (
                      <>
                        {" "}
                        · this environment overrides <span className="mono">{overridden.map((v) => v.name).join(", ")}</span>
                      </>
                    )}
                  </div>
                  {inherited.map((variable) => (
                    <div key={variable.name} className="env-inherited-row">
                      <span className="mono env-inherited-name">{variable.name}</span>
                      <span className="mono env-inherited-value">
                        {variable.secret ? "••••••" : variable.value || <span className="meta">empty</span>}
                      </span>
                      <button
                        type="button"
                        className="btn ghost tight"
                        title={`Give ${variable.name} its own value in ${selected.name || "this environment"}`}
                        onClick={() => update({ ...selected, variables: [...selected.variables, { ...variable }] })}
                      >
                        Override
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <p className="env-note meta" title={location ? `Stored in ${location}` : undefined}>
                <Lock size={12} aria-hidden /> {storage.where} <span className="mono">environments.json</span> only records
                that a secret exists.
              </p>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
