import { useMemo, useState } from "react";
import { buildSchemaGraph } from "@spec0/schema-graph";
import { SchemaGraphView } from "@spec0/schema-graph/react";
import { X } from "lucide-react";
import { Resizer } from "./Resizer";
import { SchemaView } from "./SchemaView";
import type { ParsedSpec } from "../lib/spec";

interface Props {
  spec: ParsedSpec;
  /** The schema shown in the side panel; null closes the panel. */
  focus: string | null;
  onFocus: (name: string | null) => void;
  panelWidth: number;
  onPanelWidth: (width: number) => void;
  onSelectOperation: (id: string) => void;
}

/** The schema graph, with a narrow panel for the selected schema. */
export function GraphView({ spec, focus, onFocus, panelWidth, onPanelWidth, onSelectOperation }: Props) {
  const [operations, setOperations] = useState(false);
  const [simple, setSimple] = useState(false);
  // Tidy up puts back the boxes the user dragged; the graph says when there are any.
  const [tidy, setTidy] = useState(0);
  const [moved, setMoved] = useState(false);
  const graph = useMemo(() => buildSchemaGraph(spec.doc), [spec.doc]);
  const names = useMemo(() => graph.schemas.map((s) => s.name).sort((a, b) => a.localeCompare(b)), [graph]);
  const simpleCount = graph.schemas.filter((s) => s.simple).length;

  return (
    <div className="split graph-split">
      {/* The canvas keeps every pixel the panel isn't using: the detail
          panel is a narrow, draggable, dismissible sidecar, not a second
          half of the screen. */}
      <div className="graph-wrap">
        <SchemaGraphView
          key={spec.sourceName}
          graph={graph}
          initialSchema={focus ?? undefined}
          height="100%"
          hidePanel
          toolbar={false}
          operations={operations}
          simple={simple}
          onSelectSchema={onFocus}
          tidyUp={tidy}
          onMovedChange={setMoved}
        />
        <div className="graph-toolbar">
          <div className="segmented" role="radiogroup" aria-label="What the graph shows">
            <button type="button" role="radio" aria-checked={!operations} className="segment" onClick={() => setOperations(false)}>
              Schemas
            </button>
            <button type="button" role="radio" aria-checked={operations} className="segment" onClick={() => setOperations(true)}>
              With operations
            </button>
          </div>
          {names.length > 0 && (
            <label className="graph-focus">
              <span className="meta">Focus</span>
              <select className="select" value={focus ?? ""} onChange={(event) => onFocus(event.target.value || null)}>
                {!focus && <option value="">Most connected</option>}
                {names.map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
            </label>
          )}
          {simpleCount > 0 && (
            <label className="graph-simple" title="Named primitives, enums and arrays of scalars: nothing to expand">
              <input
                type="checkbox"
                className="switch"
                role="switch"
                checked={simple}
                onChange={(event) => setSimple(event.target.checked)}
              />
              Simple types <span className="mono meta">{simpleCount}</span>
            </label>
          )}
          <button
            type="button"
            className="btn tight graph-tidy"
            disabled={!moved}
            onClick={() => setTidy((n) => n + 1)}
            title={moved ? "Put the boxes you moved back and lay the graph out again" : "Drag a box to arrange the graph"}
          >
            Tidy up
          </button>
          <span className="spacer" />
          <div className="graph-legend meta" aria-label="Legend">
            <span>
              <span className="legend-line ref" aria-hidden /> field refers to
            </span>
            {operations && (
              <span>
                <span className="legend-line uses" aria-hidden /> operation uses
              </span>
            )}
            <span>Click a schema for its fields</span>
          </div>
        </div>
      </div>
      {focus && (
        <>
          <Resizer width={panelWidth} onChange={onPanelWidth} min={260} max={620} />
          <section
            className="pane detail"
            style={{ width: panelWidth, flex: `0 0 ${panelWidth}px` }}
          >
            <div className="detail-head">
              <span className="meta">Schema</span>
              <span className="spacer" />
              <button
                className="icon-btn tight"
                onClick={() => onFocus(null)}
                title="Close panel"
                aria-label="Close schema panel"
              >
                <X size={14} />
              </button>
            </div>
            <SchemaView
              spec={spec}
              name={focus}
              onSelectSchema={onFocus}
              onSelectOperation={onSelectOperation}
            />
          </section>
        </>
      )}
    </div>
  );
}
