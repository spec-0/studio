import { ChevronDown, ChevronLeft, PanelRightClose, PanelRightOpen, Play, Server } from "lucide-react";
import { LocalMockControl } from "./LocalMockControl";
import { TabList } from "./TabList";
import { API_SECTIONS, type ApiSection } from "../lib/navigation";
import { shortcut } from "../lib/platform";
import type { SourceKind } from "../lib/library";
import { CONVERTED_LABEL, describeConversion } from "../lib/swagger2";

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
  /** Present when the file was Swagger 2.0 and Studio converted it: where the conversion guessed. */
  converted?: { notes: string[] } | null;
  section: ApiSection;
  onSection: (section: ApiSection) => void;
  onSwitchApi: () => void;
  onRun: () => void;
  /**
   * The API's hosted mock: create one, or see it (address, key, rebuild).
   * Offered whether or not Studio has noticed drift.
   */
  mock?: { has: boolean; onOpen: () => void } | null;
  /** This API's local mock: start it, or its address and a stop button while it runs. */
  localMock?: {
    port: number | null;
    busy: boolean;
    error: string | null;
    onStart: () => void;
    onStop: () => void;
  } | null;
}

/** The id of the region the API tabs control. */
export const API_PANEL_ID = "api-panel";

/**
 * The bar under the top bar while an API (or the scratch screen) is open: which
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
          <span className="chip">no spec</span>
        </span>
        <span className="spacer" />
        {responseToggle}
      </div>
    );
  }

  // One row: the API (name, version, source) with its views right after it,
  // then its actions. Add API is the library's action, and ⌘O anywhere.
  const name = props.version ? `${props.title} ${props.version}` : props.title;
  return (
    <div className="apibar">
      {back}
      <button
        className="api-switch"
        onClick={props.onSwitchApi}
        title={`${name}: switch API (${shortcut("P")})`}
        aria-label={`${name}. Switch API`}
      >
        <span className="spec-name">{props.title}</span>
        {props.version && <span className="chip">{props.version}</span>}
        {props.source && props.source !== "sample" && <span className="chip">{props.source}</span>}
        <ChevronDown size={13} className="chev" />
      </button>
      {props.converted && (
        <span className="meta converted-note" title={describeConversion(props.converted.notes)}>
          {CONVERTED_LABEL}
        </span>
      )}
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

      {props.localMock && <LocalMockControl {...props.localMock} />}
      {props.mock && (
        <button
          className="btn ghost"
          onClick={props.mock.onOpen}
          title={props.mock.has ? "The hosted mock's address and key; rebuild it" : "Create a hosted mock server for this API"}
        >
          <Server size={13} /> <span className="lbl">{props.mock.has ? "Hosted mock" : "Create mock"}</span>
        </button>
      )}
      <button className="btn ghost" onClick={props.onRun} title="Run operations against the spec and check each response">
        <Play size={13} /> <span className="lbl">Run</span>
      </button>
      {props.section === "operations" && responseToggle}
    </div>
  );
}
