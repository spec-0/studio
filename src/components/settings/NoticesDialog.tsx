import { useEffect, useState } from "react";
import { Dialog } from "../Dialog";

/** Written next to the app at build time; see scripts/third-party-notices.ts. */
const NOTICES_URL = "/third-party-notices.txt";

/** The licences and notices of the open-source packages built into Studio. */
export function NoticesDialog({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    fetch(NOTICES_URL)
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error(String(response.status)))))
      .then((body) => live && setText(body))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, []);
  return (
    <Dialog
      title="Open-source licences"
      subtitle="The packages built into Studio, with their licence and notice texts."
      onClose={onClose}
      wide
    >
      {failed ? (
        <p className="meta">The list is written when Studio is built, so a development build doesn&apos;t have one.</p>
      ) : text === null ? (
        <p className="meta">Loading…</p>
      ) : (
        <pre className="code notices-text" tabIndex={0} aria-label="Licence texts">
          {text}
        </pre>
      )}
    </Dialog>
  );
}
