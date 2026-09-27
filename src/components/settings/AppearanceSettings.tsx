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
    <>
      <section className="section">
        <h3 id="theme-label">Theme</h3>
        <div className="choice-row" role="radiogroup" aria-labelledby="theme-label">
          {([false, true] as const).map((value) => (
            <label key={String(value)} className={`choice${dark === value ? " on" : ""}`}>
              <input
                type="radio"
                name="theme"
                checked={dark === value}
                onChange={() => onDark(value)}
              />
              {value ? <Moon size={14} aria-hidden /> : <Sun size={14} aria-hidden />}
              {value ? "Dark" : "Light"}
            </label>
          ))}
        </div>
        <p className="field-meta">Switch at any time with {shortcut("D")}.</p>
      </section>

      <section className="section">
        <h3>Response pane</h3>
        <label className="check">
          <input
            type="checkbox"
            checked={inspectorOpen}
            onChange={(event) => onInspectorOpen(event.target.checked)}
          />
          Show the response pane next to the request
        </label>
        <p className="field-meta">
          Also from the button beside Add API, or with {shortcut("\\")}.
        </p>
      </section>
    </>
  );
}
