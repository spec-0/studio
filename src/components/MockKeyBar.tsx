import { useState } from "react";
import { KeyRound, TriangleAlert } from "lucide-react";

interface Props {
  apiName: string;
  onSave: (key: string) => void;
}

/**
 * Prompt for a mock server's API key, shown only while the address bar is pointed
 * at a mock we have no key for.
 *
 * This exists because the key is genuinely unobtainable from the API: it is
 * returned once, at creation, and neither the list endpoint nor a repeat create
 * carries it. The backend also rejects the platform session token on mock routes
 * (`MISSING_MOCK_API_KEY`), so there is no automatic path — the honest answer is
 * to ask for it once and remember it, rather than let the request fail and leave
 * the user to work out why.
 */
export function MockKeyBar({ apiName, onSave }: Props) {
  const [value, setValue] = useState("");

  return (
    <div className="mock-key-bar">
      <TriangleAlert size={13} />
      <span>
        This mock needs its own key — <code>X-Mock-API-Key</code>. Your spec0 login isn&apos;t
        accepted on mock routes, and the key is only shown when a mock is first created, so copy it
        from the spec0 dashboard.
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
