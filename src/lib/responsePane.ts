import type { ResponseResult } from "./request";
import type { Route } from "./navigation";
import type { ValidationResult } from "./validate";

/**
 * What the response pane shows, and which request it belongs to.
 *
 * The pane only ever shows the answer to the request on screen, and never an
 * old answer as if it were new. Picking another operation, another API or the
 * scratch pad takes the response off screen. Going back to an operation (from
 * its tab, or the sidebar) during the same session brings its last response
 * back, marked as restored with the time it was sent, and the view says when
 * the request has been edited since. Nothing is kept across restarts: after
 * that, an operation's last response is in History, with the time it ran.
 *
 * No React here, so the rules can be tested directly. The hook that holds this
 * state is `src/hooks/useRequestSender.ts`.
 */

export interface ResponsePane {
  /** The request the pane belongs to (see `paneOwner`), or null before anything is shown. */
  owner: string | null;
  /**
   * The send the pane is waiting on. Its result is dropped if this has moved on
   * while it was in flight: the user picked something else, cleared the pane,
   * or sent again.
   */
  sendId: number | null;
  sending: boolean;
  result: ResponseResult | null;
  validation: ValidationResult | null;
  error: string | null;
  curl: string | null;
  /** When the request whose answer this is was sent. */
  sentAt: string | null;
  /** What the editor held when it was sent (see `editorFingerprint`), to tell if it changed since. */
  fingerprint: string | null;
  /** Brought back from earlier in the session, rather than the answer to a send just made. */
  restored: boolean;
  /** Other requests' last answers this session, by owner, oldest first. */
  kept: Record<string, KeptResponse>;
}

/** An answer kept while its request is off screen. */
export type KeptResponse = Pick<ResponsePane, "result" | "validation" | "error" | "curl" | "sentAt" | "fingerprint">;

/** How many off-screen answers are kept; about one per tab. The oldest go first. */
export const KEPT_LIMIT = 20;

export const EMPTY_PANE: ResponsePane = {
  owner: null,
  sendId: null,
  sending: false,
  result: null,
  validation: null,
  error: null,
  curl: null,
  sentAt: null,
  fingerprint: null,
  restored: false,
  kept: {},
};

/** The pane's own fields, without the kept answers. */
const BLANK = {
  sendId: null,
  sending: false,
  result: null,
  validation: null,
  error: null,
  curl: null,
  sentAt: null,
  fingerprint: null,
  restored: false,
} as const;

function keep(kept: Record<string, KeptResponse>, owner: string, pane: ResponsePane): Record<string, KeptResponse> {
  const next = { ...kept };
  delete next[owner];
  // Only a finished answer is worth bringing back. A send still in flight goes
  // to History only, as before.
  if (!pane.sending && (pane.result || pane.error)) {
    next[owner] = {
      result: pane.result,
      validation: pane.validation,
      error: pane.error,
      curl: pane.curl,
      sentAt: pane.sentAt,
      fingerprint: pane.fingerprint,
    };
  }
  const owners = Object.keys(next);
  for (const old of owners.slice(0, Math.max(0, owners.length - KEPT_LIMIT))) delete next[old];
  return next;
}

/** The pane for `owner`: its kept answer marked as restored, or empty. */
function paneFor(owner: string, kept: Record<string, KeptResponse>): ResponsePane {
  const answer = kept[owner];
  return answer ? { ...BLANK, ...answer, owner, restored: true, kept } : { ...BLANK, owner, kept };
}

/**
 * Which request the pane belongs to on this screen: the scratch pad, or one
 * operation of one API. Null on screens without a response pane (Settings,
 * History, Mocks…), so passing through them doesn't clear what was there.
 */
export function paneOwner(
  route: Route,
  apiId: string | undefined,
  operationId: string | undefined,
): string | null {
  if (route === "scratch") return "scratch";
  if (route === "api" && apiId && operationId) return `api:${apiId}:${operationId}`;
  return null;
}

export type PaneAction =
  /**
   * The screen now shows `owner`'s request. A different owner puts the current
   * answer aside and brings back `owner`'s, if it has one this session.
   */
  | { type: "show"; owner: string | null }
  /**
   * Empty the pane. The curl line stays unless `curl` is set. With `owner`, the
   * answer kept for that request is dropped instead, when it isn't on screen.
   */
  | { type: "clear"; curl?: boolean; owner?: string | null }
  /** A send started. `sendId` is unique per send; the steps below carry it. */
  | { type: "start"; sendId: number; sentAt?: string; fingerprint?: string | null }
  | { type: "curl"; sendId: number; curl: string }
  | { type: "response"; sendId: number; result: ResponseResult; validation: ValidationResult | null }
  | { type: "fail"; sendId: number; error: string }
  | { type: "done"; sendId: number }
  /** An error that isn't about a send, like saving a body. Always shown. */
  | { type: "error"; error: string };

export function paneReducer(pane: ResponsePane, action: PaneAction): ResponsePane {
  switch (action.type) {
    case "show": {
      if (action.owner === null || action.owner === pane.owner) return pane;
      const kept = pane.owner ? keep(pane.kept, pane.owner, pane) : pane.kept;
      const next = paneFor(action.owner, kept);
      const rest = { ...next.kept };
      delete rest[action.owner];
      return { ...next, kept: rest };
    }
    case "clear": {
      if (action.owner && action.owner !== pane.owner) {
        if (!(action.owner in pane.kept)) return pane;
        const kept = { ...pane.kept };
        delete kept[action.owner];
        return { ...pane, kept };
      }
      return { ...pane, ...BLANK, curl: action.curl ? null : pane.curl };
    }
    case "start":
      return {
        ...pane,
        sendId: action.sendId,
        sending: true,
        result: null,
        validation: null,
        error: null,
        sentAt: action.sentAt ?? null,
        fingerprint: action.fingerprint ?? null,
        restored: false,
      };
    case "error":
      return { ...pane, error: action.error };
  }
  // Everything below belongs to one send, and is dropped if the pane moved on.
  if (action.sendId !== pane.sendId) return pane;
  switch (action.type) {
    case "curl":
      return { ...pane, curl: action.curl };
    case "response":
      return { ...pane, result: action.result, validation: action.validation };
    case "fail":
      return { ...pane, error: action.error };
    case "done":
      return { ...pane, sendId: null, sending: false };
  }
}

/**
 * The pane as the screen should draw it right now.
 *
 * `show` is dispatched from an effect, which runs after the first paint of the
 * new screen. Until then the pane still holds the previous owner's response;
 * this keeps it from flashing up next to the new request, and shows the new
 * owner's kept answer straight away.
 */
export function visiblePane(pane: ResponsePane, owner: string | null): ResponsePane {
  return owner === null || owner === pane.owner ? pane : paneFor(owner, pane.kept);
}
