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
  return (
    <div className="split graph-split">
      {/* The canvas keeps every pixel the panel isn't using — the detail
          panel is a narrow, draggable, dismissible sidecar, not a second
          half of the screen. */}
      <div className="graph-wrap">
        <SchemaGraphView
          key={spec.sourceName}
          spec={spec.doc}
          initialSchema={focus ?? undefined}
          height="100%"
          hidePanel
          onSelectSchema={onFocus}
        />
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
