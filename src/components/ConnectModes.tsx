import { Cloud, CloudOff } from "lucide-react";

/**
 * What works locally and what signing in to Spec0 adds, side by side.
 *
 * Shown where someone is deciding whether to sign in (the Open dialog's spec0
 * tab and Settings), because that's exactly the question they're asking. It
 * never appears anywhere else as a prompt.
 */
export function ConnectModes() {
  return (
    <div className="modes">
      <div className="mode">
        <div className="mode-head">
          <CloudOff size={13} />
          <strong>Local</strong>
          <span className="tag ok">now</span>
        </div>
        <ul>
          <li>Open specs from a file, a URL, or the sample</li>
          <li>Browse operations, schemas and the schema graph</li>
          <li>Auth, custom headers, environments and secrets</li>
          <li>Send requests to any host</li>
          <li>Response validation and drift detection</li>
          <li>Request history</li>
        </ul>
        <p className="meta">No account. No network call to spec0. Ever.</p>
      </div>
      <div className="mode">
        <div className="mode-head">
          <Cloud size={13} />
          <strong>Signed in</strong>
          <span className="tag">adds</span>
        </div>
        <ul>
          <li>Your organisation&apos;s API catalog</li>
          <li>Import any org API, private or published</li>
          <li>Re-pull a spec when it changes upstream</li>
          <li>Discover and create hosted mock servers</li>
          <li>Target a mock from the address bar</li>
        </ul>
        <p className="meta">Signing out reverts to Local. Nothing you added is lost.</p>
      </div>
    </div>
  );
}
