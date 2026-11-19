import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { deref, typeLabel, type Json } from "../lib/spec";
import { plural } from "../lib/plural";
import { Description } from "./Description";

/**
 * A schema's fields under a disclosure: its name and field count, then a table
 * of each field's type and description. Nothing is shown for a schema without
 * properties, such as a string or an array of strings.
 */
export function SchemaFields({
  doc,
  schema,
  defaultOpen = false,
}: {
  doc: Json;
  schema: Json | undefined;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const resolved = deref(doc, schema);
  const properties = Object.entries<Json>(resolved?.properties ?? {});
  if (!properties.length) return null;
  const required: string[] = resolved.required ?? [];
  const name = typeLabel(doc, schema);

  return (
    <div className="disc">
      <button type="button" className="disc-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <ChevronRight size={13} className={`disc-chev${open ? " open" : ""}`} aria-hidden />
        <span className="mono">{name}</span>
        <span className="meta">
          · {plural(properties.length, "field")}
          {required.length ? `, ${required.length} required` : ""}
        </span>
      </button>
      {open && (
        <table className="tbl disc-body">
          <thead>
            <tr>
              <th>Field</th>
              <th>Type</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {properties.map(([field, prop]) => {
              const description = deref(doc, prop)?.description;
              return (
                <tr key={field}>
                  <td className="mono top">
                    {field}
                    {required.includes(field) && <span className="required-word">required</span>}
                  </td>
                  <td className="mono top type-cell">{typeLabel(doc, prop)}</td>
                  <td className="top">{description ? <Description text={description} /> : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
