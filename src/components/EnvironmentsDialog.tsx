import { useEffect, useState } from "react";
import {
  newEnvironment,
  type Environment,
  type EnvironmentFile,
  type Variable,
} from "../lib/env";
import { storeLocation } from "../lib/store";

interface Props {
  file: EnvironmentFile;
  onSave: (file: EnvironmentFile) => void;
  onClose: () => void;
}

export function EnvironmentsDialog({ file, onSave, onClose }: Props) {
  const [draft, setDraft] = useState<EnvironmentFile>(file);
  const [selectedId, setSelectedId] = useState<string | null>(
    file.activeId ?? file.environments[0]?.id ?? null,
  );
  const [location, setLocation] = useState("");

  useEffect(() => {
    void storeLocation().then(setLocation);
  }, []);

  const selected = draft.environments.find((env) => env.id === selectedId) ?? null;

  const update = (next: Environment) =>
    setDraft((prev) => ({
      ...prev,
      environments: prev.environments.map((env) => (env.id === next.id ? next : env)),
    }));

  const addEnvironment = () => {
    const created = newEnvironment(`Environment ${draft.environments.length + 1}`);
    setDraft((prev) => ({
      environments: [...prev.environments, created],
      activeId: prev.activeId ?? created.id,
    }));
    setSelectedId(created.id);
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

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal wide" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <strong>Environments</strong>
          <span className="spacer" />
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
        </div>

        <div className="modal-body split">
          <div className="env-list">
            {draft.environments.map((env) => (
              <button
                key={env.id}
                className="row"
                aria-selected={env.id === selectedId}
                onClick={() => setSelectedId(env.id)}
              >
                <span className="path" style={{ flex: 1 }}>
                  {env.name}
                </span>
                <span className="count">{env.variables.length}</span>
              </button>
            ))}
            <button className="btn" style={{ margin: 8 }} onClick={addEnvironment}>
              + New environment
            </button>
          </div>

          <div className="env-detail">
            {!selected ? (
              <p className="meta">
                No environments yet. Create one to hold `{"{{baseUrl}}"}`, tokens, and per-stage
                values.
              </p>
            ) : (
              <>
                <div className="field">
                  <div className="field-label">
                    <div className="field-name">name</div>
                  </div>
                  <input
                    value={selected.name}
                    onChange={(event) => update({ ...selected, name: event.target.value })}
                  />
                </div>
                <h3 style={{ marginTop: 18 }}>Variables</h3>
                <table className="fields">
                  <thead>
                    <tr>
                      <th style={{ width: "34%" }}>Name</th>
                      <th>Value</th>
                      <th style={{ width: 72 }}>Secret</th>
                      <th style={{ width: 34 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {selected.variables.map((variable, index) => (
                      <tr key={index}>
                        <td>
                          <input
                            value={variable.name}
                            placeholder="baseUrl"
                            onChange={(event) => setVariable(index, { name: event.target.value })}
                          />
                        </td>
                        <td>
                          <input
                            type={variable.secret ? "password" : "text"}
                            value={variable.value}
                            onChange={(event) => setVariable(index, { value: event.target.value })}
                          />
                        </td>
                        <td style={{ textAlign: "center" }}>
                          <input
                            type="checkbox"
                            style={{ width: "auto" }}
                            checked={variable.secret}
                            onChange={(event) =>
                              setVariable(index, { secret: event.target.checked })
                            }
                          />
                        </td>
                        <td>
                          <button
                            className="btn"
                            style={{ padding: "2px 7px" }}
                            onClick={() =>
                              update({
                                ...selected,
                                variables: selected.variables.filter((_, i) => i !== index),
                              })
                            }
                          >
                            ×
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <button
                  className="btn"
                  style={{ marginTop: 10 }}
                  onClick={() =>
                    update({
                      ...selected,
                      variables: [...selected.variables, { name: "", value: "", secret: false }],
                    })
                  }
                >
                  + Add variable
                </button>

                <p className="meta" style={{ marginTop: 18, lineHeight: 1.6 }}>
                  Use them anywhere as <code>{"{{name}}"}</code> — base URL, parameters, headers,
                  auth, body. An environment supplies <strong>values</strong>, not destinations:
                  where a request goes is chosen in the address bar. A <code>baseUrl</code> variable
                  is a good habit, and it&apos;s an ordinary variable like any other.
                  <br />
                  Secret values are written to a separate local file, so{" "}
                  <code>environments.json</code> stays safe to commit — it records that a variable
                  is secret, not its value.{" "}
                  <strong>That file is not encrypted at rest</strong> (Tauri ships no first-party
                  keychain plugin).
                  {location && (
                    <>
                      <br />
                      Stored in <code>{location}</code>
                    </>
                  )}
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
