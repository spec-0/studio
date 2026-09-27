import { ChevronDown, ChevronLeft, PanelRightClose, PanelRightOpen, Play, Plus, Server } from "lucide-react";
import { TabList } from "./TabList";
import { API_SECTIONS, type ApiSection } from "../lib/navigation";
import { shortcut } from "../lib/platform";
import type { SourceKind } from "../lib/library";

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
  /** Where the open API came from: a file, a URL, Spec0 or the sample. */
  source?: SourceKind;
  section: ApiSection;
  onSection: (section: ApiSection) => void;
  onSwitchApi: () => void;
  onRun: () => void;
  onAddApi: () => void;
  /**
   * The API's hosted mock: create one, or see it (address, key, rebuild).
   * Offered whether or not Studio has noticed drift.
   */
  mock?: { has: boolean; onOpen: () => void } | null;
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

  // Two rows: the API's name on its own, so it is never cropped to make room
  // for the tabs and actions, and the views with their actions below it.
  const name = props.version ? `${props.title} ${props.version}` : props.title;
  return (
    <div className="apihead">
    <div className="apibar-title">
      {back}
      <button
        className="api-switch"
        onClick={props.onSwitchApi}
        title={`${name} — switch API (${shortcut("P")})`}
        aria-label={`${name}. Switch API`}
      >
        <span className="spec-name">{props.title}</span>
        {props.version && <span className="spec-version">{props.version}</span>}
        <ChevronDown size={13} className="chev" />
      </button>
      {props.source && props.source !== "sample" && (
        <span className={`tag src-${props.source}`}>{props.source === "spec0" ? "spec0" : props.source}</span>
      )}
    </div>
    <div className="apibar tools">
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

      {props.mock && (
        <button
          className="btn ghost"
          onClick={props.mock.onOpen}
          title={props.mock.has ? "The mock's address and key; rebuild it" : "Create a hosted mock server for this API"}
        >
          <Server size={13} /> {props.mock.has ? "Mock" : "Create mock"}
        </button>
      )}
      <button className="btn ghost" onClick={props.onRun} title="Run operations against the spec and check each response">
        <Play size={13} /> Run
      </button>
      {props.section === "operations" && responseToggle}
      <button className="btn primary" onClick={props.onAddApi} title={`Add API (${shortcut("O")})`}>
        <Plus size={13} /> Add API
      </button>
    </div>
    </div>
  );
}
