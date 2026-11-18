import { Moon, Sun } from "lucide-react";
import { shortcut } from "../../lib/platform";

interface Props {
  dark: boolean;
  onDark: (dark: boolean) => void;
  inspectorOpen: boolean;
  onInspectorOpen: (open: boolean) => void;
}

/** Appearance: the theme and the response pane. */
export function AppearanceSettings({ dark, onDark, inspectorOpen, onInspectorOpen }: Props) {
  return (
    <div className="rows">
      <div className="row-s">
        <div className="l">
          <b id="theme-label">Theme</b>
          <span className="meta">
            <span className="kbd">{shortcut("D")}</span> switches at any time.
          </span>
        </div>
        <div className="c">
          <span className="segmented sm" role="radiogroup" aria-labelledby="theme-label">
            {([false, true] as const).map((value) => (
              <button
                key={String(value)}
                type="button"
                role="radio"
                className="segment"
                aria-checked={dark === value}
                onClick={() => onDark(value)}
              >
                {value ? <Moon size={13} aria-hidden /> : <Sun size={13} aria-hidden />}
                {value ? "Dark" : "Light"}
              </button>
            ))}
          </span>
        </div>
      </div>
      <div className="row-s">
        <div className="l">
          <b>Response pane</b>
          <span className="meta">
            Show the response next to the request. Also the button at the end of the API bar, or{" "}
            <span className="kbd">{shortcut("\\")}</span>.
          </span>
        </div>
        <div className="c">
          <input
            type="checkbox"
            className="switch"
            role="switch"
            aria-label="Show the response pane"
            checked={inspectorOpen}
            onChange={(event) => onInspectorOpen(event.target.checked)}
          />
        </div>
      </div>
    </div>
  );
}
