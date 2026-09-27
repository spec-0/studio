import { useState } from "react";
import { KeyRound, TriangleAlert } from "lucide-react";

interface Props {
  apiName: string;
  onSave: (key: string) => void;
}

/**
 * Prompt for a mock server's API key, shown only while the address bar is pointed
 * at a mock we have no key for and Spec0 couldn't provide it (signed out, an
 * older platform, or no permission to read it). Studio asks Spec0 first; this
 * is the fallback, so a request never fails without saying why.
 */
export function MockKeyBar({ apiName, onSave }: Props) {
  const [value, setValue] = useState("");

  return (
    <div className="mock-key-bar">
      <TriangleAlert size={13} />
      <span>
        This mock needs its own key — <code>X-Mock-API-Key</code>. Studio couldn&apos;t get it from
        Spec0, so copy it from the mock&apos;s page there and paste it here.
      </span>
      <span className="spacer" />
      <div className="mock-key-field">
        <KeyRound size={12} />
        <input
          type="password"
          value={value}
          placeholder={`Mock key for ${apiName}`}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && value.trim()) onSave(value.trim());
          }}
        />
      </div>
      <button className="btn" disabled={!value.trim()} onClick={() => onSave(value.trim())}>
        Save
      </button>
    </div>
  );
}
