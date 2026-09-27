import { ChevronDown, ChevronLeft, PanelRightClose, PanelRightOpen, Play, Plus } from "lucide-react";
import { TabList } from "./TabList";
import { API_SECTIONS, type ApiSection } from "../lib/navigation";
import { shortcut } from "../lib/platform";

type Props =
  | ({ kind: "api" } & ApiProps)
  | ({ kind: "scratch" } & CommonProps);

interface CommonProps {
  onGoLibrary: () => void;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
}

interface ApiProps extends CommonProps {
  title: string;
  version?: string;
  /** The open API came from Spec0. */
  fromSpec0: boolean;
  section: ApiSection;
  onSection: (section: ApiSection) => void;
  onSwitchApi: () => void;
  onRun: () => void;
  onAddApi: () => void;
}

/** The id of the region the API tabs control. */
export const API_PANEL_ID = "api-panel";

/**
 * The bar under the top bar while an API (or the scratch pad) is open: which
 * one, its four views as tabs, and the actions that belong to it.
 */
export function ApiBar(props: Props) {
  const back = (
    <button
      className="icon-btn"
      onClick={props.onGoLibrary}
      title={`All APIs (${shortcut("L")})`}
      aria-label="Back to all APIs"
    >
      <ChevronLeft size={16} />
    </button>
  );

  const responseToggle = (
    <button
      className="icon-btn"
      onClick={props.onToggleInspector}
      title={`Response pane (${shortcut("\\")})`}
      aria-label="Toggle response pane"
      aria-pressed={props.inspectorOpen}
    >
      {props.inspectorOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
    </button>
  );

  if (props.kind === "scratch") {
    return (
      <div className="apibar">
        {back}
        <span className="api-switch static">
          <span className="spec-name">Scratch</span>
          <span className="tag">no spec</span>
        </span>
        <span className="spacer" />
        {responseToggle}
      </div>
    );
  }

  return (
    <div className="apibar">
      {back}
      <button className="api-switch" onClick={props.onSwitchApi} title={`Switch API (${shortcut("P")})`}>
        <span className="spec-name">{props.title}</span>
        {props.version && <span className="spec-version">{props.version}</span>}
        <ChevronDown size={13} className="chev" />
      </button>
      {props.fromSpec0 && <span className="tag ok">spec0</span>}

      <TabList
        className="segmented"
        tabClassName="segment"
        label="API views"
        idPrefix="api-tab"
        controls={API_PANEL_ID}
        tabs={API_SECTIONS.map((section) => ({
          id: section.id,
          label: section.label,
          title: `${section.label} (${shortcut(section.key)})`,
        }))}
        selected={props.section}
        onSelect={props.onSection}
      />

      <span className="spacer" />

      <button className="btn ghost" onClick={props.onRun} title="Run operations against the spec and check each response">
        <Play size={13} /> Run
      </button>
      {props.section === "operations" && responseToggle}
      <button className="btn primary" onClick={props.onAddApi} title={`Add API (${shortcut("O")})`}>
        <Plus size={13} /> Add API
      </button>
    </div>
  );
}
