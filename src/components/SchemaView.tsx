import { Shapes } from "lucide-react";
import { useMemo, useState } from "react";
import { deref, typeLabel, type Json, type ParsedSpec } from "../lib/spec";
import { exampleFor } from "../lib/example";
import { plural } from "../lib/plural";
import { Description } from "./Description";
import { TabList } from "./TabList";
import { EmptyState } from "./EmptyState";
import { CodeBlock } from "./CodeBlock";

/**
 * A field name that may wrap between its words (`shipping` / `Address`,
 * `line_items`) rather than at whatever letter reaches the edge of a narrow column.
 */
function BreakableName({ name }: { name: string }) {
  const parts = name.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[_-])/);
  return (
    <>
      {parts.map((part, i) => (
        <span key={i}>
          {i > 0 && <wbr />}
          {part}
        </span>
      ))}
    </>
  );
}

interface Props {
  spec: ParsedSpec;
  name: string;
  onSelectSchema: (name: string) => void;
  onSelectOperation: (id: string) => void;
}

/**
 * Schema detail: the structure as a readable tree rather than raw JSON, plus the
 * two navigation affordances no generic client has: what this references, and
 * which operations carry it.
 */
export function SchemaView({ spec, name, onSelectSchema, onSelectOperation }: Props) {
  const [view, setView] = useState<"fields" | "example" | "raw">("fields");
  const entry = spec.schemas.find((s) => s.name === name);
  const schema = entry?.schema;

  const { fields, required, references } = useMemo(() => {
    if (!schema) return { fields: [] as [string, Json][], required: [] as string[], references: [] as string[] };
    const resolved = deref(spec.doc, schema);

    // `allOf` contributes its parents' fields; show them merged, as a reader expects.
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

  if (!schema) return <EmptyState icon={<Shapes size={18} />} title="Schema not found" body="It may have been renamed or removed from the spec." />;

  return (
    <>
      <div className="schema-head">
        <div className="schema-title">{name}</div>
        <div className="meta" style={{ marginTop: 4 }}>
          {plural(fields.length, "field")} ·{" "}
          {referencedBy.length ? `referenced by ${plural(referencedBy.length, "schema")}` : "not referenced by other schemas"} ·{" "}
          {usedBy.length ? `used in ${plural(usedBy.length, "operation")}` : "not used by any operation"}
        </div>
        {deref(spec.doc, schema).description && (
          <Description text={deref(spec.doc, schema).description} className="op-summary" />
        )}
      </div>

      <div className="op-body">
        <TabList<"fields" | "example" | "raw">
          className="ptabs schema-tabs"
          tabClassName="ptab"
          label="Schema"
          tabs={[
            { id: "fields", label: <>Fields <span className="c">{fields.length}</span></> },
            { id: "example", label: "Example" },
            { id: "raw", label: "Raw" },
          ]}
          selected={view}
          onSelect={setView}
        />

        {view === "fields" && (
          <table className="tbl schema-fields">
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
                    <td className="mono top field-cell">
                      <BreakableName name={field} />
                      {required.includes(field) && <span className="required-word">required</span>}
                    </td>
                    <td className="mono top type-cell">
                      {target ? (
                        <button
                          className="chip link"
                          title={typeLabel(spec.doc, propSchema)}
                          onClick={() => onSelectSchema(target)}
                        >
                          {typeLabel(spec.doc, propSchema)}
                        </button>
                      ) : Array.isArray(resolved.enum) ? (
                        // The values are listed in the description column; a type cell that
                        // spelled them out would push the table off a narrow panel.
                        `enum · ${plural(resolved.enum.length, "value")}`
                      ) : (
                        typeLabel(spec.doc, propSchema)
                      )}
                    </td>
                    <td className="top">
                      {Array.isArray(resolved.enum) && resolved.enum.length > 1 && (
                        <span className="meta enum-note">
                          {resolved.enum.length} values: <span className="mono">{resolved.enum.map(String).join(", ")}</span>
                          {resolved.description ? ". " : ""}
                        </span>
                      )}
                      {resolved.description ? <Description text={resolved.description} /> : resolved.enum ? null : <span className="meta">—</span>}
                    </td>
                  </tr>
                );
              })}
              {fields.length === 0 && (
                <tr>
                  <td colSpan={3} className="desc">
                    Not an object schema: {typeLabel(spec.doc, schema)}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}

        {view === "example" && (
          <CodeBlock text={JSON.stringify(exampleFor(spec.doc, schema, name), null, 2)} syntax="json" />
        )}
        {view === "raw" && (
          <CodeBlock text={JSON.stringify(schema, null, 2)} syntax="json" />
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
            <table className="tbl">
              <tbody>
                {usedBy.map((op) => (
                  <tr key={op.id} className="clickable" onClick={() => onSelectOperation(op.id)} title="Open the operation">
                    <td className="used-method">
                      <span className={`method ${op.method.toLowerCase()}`}>{op.method}</span>
                    </td>
                    <td className="mono">{op.path}</td>
                    <td className="meta">{op.summary ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
