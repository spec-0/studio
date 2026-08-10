import { useMemo, useState } from "react";
import { deref, typeLabel, type Json, type ParsedSpec } from "../lib/spec";
import { exampleFor } from "../lib/example";

interface Props {
  spec: ParsedSpec;
  name: string;
  onSelectSchema: (name: string) => void;
  onSelectOperation: (id: string) => void;
}

/**
 * Schema detail: the structure as a readable tree rather than raw JSON, plus the
 * two navigation affordances no generic client has — what this references, and
 * which operations carry it.
 */
export function SchemaView({ spec, name, onSelectSchema, onSelectOperation }: Props) {
  const [view, setView] = useState<"fields" | "example" | "raw">("fields");
  const entry = spec.schemas.find((s) => s.name === name);
  const schema = entry?.schema;

  const { fields, required, references } = useMemo(() => {
    if (!schema) return { fields: [] as [string, Json][], required: [] as string[], references: [] as string[] };
    const resolved = deref(spec.doc, schema);

    // `allOf` contributes its parents' fields — show them merged, as a reader expects.
    const merged = new Map<string, Json>();
    const req = new Set<string>();
    const collect = (node: Json | undefined, depth = 0) => {
      if (!node || depth > 6) return;
      const n = deref(spec.doc, node);
      for (const [key, value] of Object.entries<Json>(n.properties ?? {})) merged.set(key, value);
      for (const r of n.required ?? []) req.add(r);
      for (const part of n.allOf ?? []) collect(part, depth + 1);
    };
    collect(resolved);

    const refs = new Set<string>();
    const walk = (node: unknown, depth = 0) => {
      if (!node || typeof node !== "object" || depth > 8) return;
      if (Array.isArray(node)) return node.forEach((n) => walk(n, depth + 1));
      for (const [key, value] of Object.entries(node as Json)) {
        if (key === "$ref" && typeof value === "string" && value.startsWith("#/components/schemas/")) {
          const target = value.slice("#/components/schemas/".length);
          if (target !== name) refs.add(target);
        } else walk(value, depth + 1);
      }
    };
    walk(schema);

    return { fields: [...merged.entries()], required: [...req], references: [...refs].sort() };
  }, [spec.doc, schema, name]);

  const referencedBy = useMemo(
    () =>
      spec.schemas
        .filter((other) => {
          if (other.name === name) return false;
          return JSON.stringify(other.schema).includes(`#/components/schemas/${name}"`);
        })
        .map((s) => s.name),
    [spec.schemas, name],
  );

  const usedBy = useMemo(
    () =>
      spec.operations.filter((op) => {
        const node = spec.doc.paths?.[op.path]?.[op.method.toLowerCase()];
        return JSON.stringify(node ?? {}).includes(`#/components/schemas/${name}"`);
      }),
    [spec.operations, spec.doc, name],
  );

  if (!schema) return <div className="empty">Schema not found.</div>;

  return (
    <>
      <div className="schema-head">
        <div className="schema-title">{name}</div>
        <div className="meta" style={{ marginTop: 4 }}>
          {fields.length} fields · referenced by {referencedBy.length} schemas · used in{" "}
          {usedBy.length} operations
        </div>
        {deref(spec.doc, schema).description && (
          <div className="op-summary">{deref(spec.doc, schema).description}</div>
        )}
      </div>

      <div className="op-body">
        <div style={{ display: "flex", gap: 4, marginTop: 12 }}>
          {(["fields", "example", "raw"] as const).map((tab) => (
            <button
              key={tab}
              className="btn"
              style={
                view === tab
                  ? { borderColor: "hsl(var(--primary))", color: "hsl(var(--primary))" }
                  : undefined
              }
              onClick={() => setView(tab)}
            >
              {tab}
            </button>
          ))}
        </div>

        {view === "fields" && (
          <table className="fields" style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th>Field</th>
                <th>Type</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {fields.map(([field, propSchema]) => {
                const resolved = deref(spec.doc, propSchema);
                const target =
                  typeof propSchema.$ref === "string"
                    ? propSchema.$ref.split("/").pop()
                    : typeof propSchema.items?.$ref === "string"
                      ? propSchema.items.$ref.split("/").pop()
                      : null;
                return (
                  <tr key={field}>
                    <td className="name">
                      {field}
                      {required.includes(field) && <span className="required">*</span>}
                    </td>
                    <td className="type">
                      {target ? (
                        <button className="chip link" onClick={() => onSelectSchema(target)}>
                          {typeLabel(spec.doc, propSchema)}
                        </button>
                      ) : (
                        typeLabel(spec.doc, propSchema)
                      )}
                    </td>
                    <td className="desc">{resolved.description ?? ""}</td>
                  </tr>
                );
              })}
              {fields.length === 0 && (
                <tr>
                  <td colSpan={3} className="desc">
                    Not an object schema — {typeLabel(spec.doc, schema)}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}

        {view === "example" && (
          <pre className="code" style={{ marginTop: 12 }}>
            {JSON.stringify(exampleFor(spec.doc, schema, name), null, 2)}
          </pre>
        )}
        {view === "raw" && (
          <pre className="code" style={{ marginTop: 12 }}>
            {JSON.stringify(schema, null, 2)}
          </pre>
        )}

        {references.length > 0 && (
          <div className="section">
            <h3>References</h3>
            {references.map((ref) => (
              <button className="chip link" key={ref} onClick={() => onSelectSchema(ref)}>
                {ref}
              </button>
            ))}
          </div>
        )}

        {referencedBy.length > 0 && (
          <div className="section">
            <h3>Referenced by</h3>
            {referencedBy.map((ref) => (
              <button className="chip link" key={ref} onClick={() => onSelectSchema(ref)}>
                {ref}
              </button>
            ))}
          </div>
        )}

        {usedBy.length > 0 && (
          <div className="section">
            <h3>Used in operations</h3>
            {usedBy.map((op) => (
              <button className="chip link" key={op.id} onClick={() => onSelectOperation(op.id)}>
                {op.method} {op.path}
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
