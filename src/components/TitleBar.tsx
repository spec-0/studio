import {
  Cable,
  ChevronDown,
  ChevronLeft,
  FileText,
  Layers,
  Moon,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plus,
  Sun,
  Waypoints,
} from "lucide-react";
import { Brand } from "./Logo";
import { ConnectionChip } from "./ConnectionChip";
import type { EnvironmentFile } from "../lib/env";
import { shortcut } from "../lib/platform";
import type { Session } from "../lib/spec0";

interface Props {
  /** The scratch pad is on screen. */
  onScratch: boolean;
  /** An API is open. */
  onApi: boolean;
  specTitle?: string;
  specVersion?: string;
  /** The open API came from spec0. */
  fromSpec0: boolean;
  session: Session | null;
  /** Certificate verification is off for at least one host. */
  insecureHosts: boolean;
  envFile: EnvironmentFile;
  onSelectEnvironment: (id: string | null) => void;
  onEditEnvironments: () => void;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  showDocument: boolean;
  onToggleDocument: () => void;
  showGraph: boolean;
  onToggleGraph: () => void;
  dark: boolean;
  onToggleTheme: () => void;
  onGoLibrary: () => void;
  onSwitchApi: () => void;
  /** The connection chip: opens the spec0 tab of the Open dialog. */
  onSignIn: () => void;
  onOpenConnection: () => void;
  onRun: () => void;
  onAddApi: () => void;
}

/** The window's top bar: where you are, the environment, and the view toggles. */
export function TitleBar({
  onScratch,
  onApi,
  specTitle,
  specVersion,
  fromSpec0,
  session,
  insecureHosts,
  envFile,
  onSelectEnvironment,
  onEditEnvironments,
  inspectorOpen,
  onToggleInspector,
  showDocument,
  onToggleDocument,
  showGraph,
  onToggleGraph,
  dark,
  onToggleTheme,
  onGoLibrary,
  onSwitchApi,
  onSignIn,
  onOpenConnection,
  onRun,
  onAddApi,
}: Props) {
  return (
      <div className="titlebar" data-tauri-drag-region>
        <Brand compact />

        {onScratch && (
          <>
            <span className="rule" />
            <button className="icon-btn" onClick={onGoLibrary} title={`All APIs (${shortcut("L")})`} aria-label="Back to all APIs">
              <ChevronLeft size={16} />
            </button>
            <span className="api-switch static">
              <span className="spec-name">Scratch</span>
              <span className="tag">no spec</span>
            </span>
          </>
        )}

        {onApi && (
          <>
            <span className="rule" />
            <button className="icon-btn" onClick={onGoLibrary} title={`All APIs (${shortcut("L")})`} aria-label="Back to all APIs">
              <ChevronLeft size={16} />
            </button>
            <button className="api-switch" onClick={onSwitchApi} title={`Switch API (${shortcut("P")})`}>
              <span className="spec-name">{specTitle}</span>
              {specVersion && <span className="spec-version">{specVersion}</span>}
              <ChevronDown size={13} className="chev" />
            </button>
            {fromSpec0 && <span className="tag ok">spec0</span>}
          </>
        )}
        <span className="spacer" />

        <ConnectionChip
          session={session}
          onClick={onSignIn}
        />

        <button
          className={`icon-btn${insecureHosts ? " warn" : ""}`}
          onClick={onOpenConnection}
          title="Connection — certificates, proxy, timeout, cookies"
          aria-label="Connection settings"
        >
          <Cable size={16} />
        </button>

        <div className="env-picker" title={`Environment (${shortcut("E")})`}>
          <Layers size={13} />
          <select
            value={envFile.activeId ?? ""}
            onChange={(event) => onSelectEnvironment(event.target.value || null)}
          >
            <option value="">No environment</option>
            {envFile.environments.map((env) => (
              <option key={env.id} value={env.id}>
                {env.name}
              </option>
            ))}
          </select>
          <button className="icon-btn tight" onClick={onEditEnvironments} aria-label="Edit environments">
            <Plus size={13} />
          </button>
        </div>

        {onScratch && (
          <button
            className="icon-btn"
            onClick={onToggleInspector}
            title={`Response pane (${shortcut("\\")})`}
            aria-label="Toggle response pane"
          >
            {inspectorOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
          </button>
        )}

        {onApi && (
          <>
            <button
              className="icon-btn"
              onClick={onRun}
              title="Run against the spec"
              aria-label="Run against the spec"
            >
              <Play size={16} />
            </button>
            <button
              className={`icon-btn${showDocument ? " on" : ""}`}
              onClick={onToggleDocument}
              title="The document"
              aria-label="The document"
            >
              <FileText size={16} />
            </button>
            <button
              className={`icon-btn${showGraph ? " on" : ""}`}
              onClick={onToggleGraph}
              title="Schema graph"
              aria-label="Schema graph"
            >
              <Waypoints size={16} />
            </button>
            <button
              className="icon-btn"
              onClick={onToggleInspector}
              title={`Response pane (${shortcut("\\")})`}
              aria-label="Toggle response pane"
            >
              {inspectorOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
            </button>
          </>
        )}
        <button
          className="icon-btn"
          onClick={onToggleTheme}
          title={`${dark ? "Light" : "Dark"} theme (${shortcut("D")})`}
          aria-label="Toggle theme"
        >
          {dark ? <Sun size={16} /> : <Moon size={16} />}
        </button>
        {/* The library screen carries its own Add button — don't offer it twice. */}
        {onApi && (
          <button className="btn primary" onClick={onAddApi}>
            <Plus size={13} /> Add API
          </button>
        )}
      </div>
  );
}
