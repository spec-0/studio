import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { DeepLinks } from "../hooks/useDeepLinks";

/**
 * "Open an API from the web?" — shown when a `spec0://open` link arrives.
 *
 * A web page can trigger the link without the user expecting Studio to act, so
 * this asks first and names the host the spec would come from. Every value here
 * came from the link and is rendered as text, never as markup. Cancel, Escape
 * and clicking outside all do nothing but close it.
 */
export function DeepLinkDialog({ links }: { links: DeepLinks }) {
  const { request, existing, notice, confirm, cancel, dismissNotice } = links;
  const cancelButton = useRef<HTMLButtonElement>(null);

  // Escape cancels wherever focus is (a link can arrive while the window isn't
  // focused), and each new link puts focus back on Cancel, so a reflexive Enter
  // never downloads anything.
  useEffect(() => {
    if (!request) return;
    cancelButton.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [request, cancel]);

  return (
    <>
      {request && (
        <div className="scrim" onClick={cancel}>
          <div
            className="modal deep-link"
            role="dialog"
            aria-modal="true"
            aria-labelledby="deep-link-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-head">
              <strong id="deep-link-title">Open an API from the web?</strong>
              <span className="spacer" />
              <button className="icon-btn tight" onClick={cancel} aria-label="Cancel">
                <X size={15} />
              </button>
            </div>

            <div className="modal-body">
              <p>
                A link asked Studio to open{" "}
                {request.name ? <strong className="deep-link-name">{request.name}</strong> : "an API"}.
              </p>

              <div className="deep-link-source">
                <span className="field-meta">{existing ? "Already in your library, from" : "Will be downloaded from"}</span>
                <span className="deep-link-host">{request.host}</span>
                <span className="deep-link-url mono" title={request.specUrl}>
                  {request.specUrl}
                </span>
              </div>

              <p className="field-meta">
                {existing
                  ? "Open shows the copy you already have. Nothing is downloaded; use Refresh in the library to fetch it again."
                  : "Nothing has been downloaded yet. Open fetches the spec from this address and adds it to your library, the same as adding it from a URL yourself."}
              </p>

              {request.ignored.length > 0 && (
                <p className="field-meta">
                  Ignored parts of the link Studio doesn't use: {request.ignored.join(", ")}.
                </p>
              )}
            </div>

            <div className="modal-foot">
              <span className="spacer" style={{ flex: 1 }} />
              <button className="btn" onClick={cancel} ref={cancelButton}>
                Cancel
              </button>
              <button className="btn primary" onClick={() => void confirm()}>
                Open
              </button>
            </div>
          </div>
        </div>
      )}

      {notice && (
        <div className="deep-link-notice" role="status">
          <span>{notice}</span>
          <button className="icon-btn tight" onClick={dismissNotice} aria-label="Dismiss">
            <X size={13} />
          </button>
        </div>
      )}
    </>
  );
}
