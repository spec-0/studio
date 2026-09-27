import type { ResponseResult } from "./request";
import type { Route } from "./navigation";
import type { ValidationResult } from "./validate";

/**
 * What the response pane shows, and which request it belongs to.
 *
 * The pane only ever shows the answer to the request on screen. Picking another
 * operation, another API or the scratch pad empties it, because a response next
 * to a request that wasn't sent reads as that request's answer. There is no
 * per-operation cache: going back to an operation shows the empty pane, and its
 * last response is in History, with the time it ran.
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
}

export const EMPTY_PANE: ResponsePane = {
  owner: null,
  sendId: null,
  sending: false,
  result: null,
  validation: null,
  error: null,
  curl: null,
};

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
  /** The screen now shows `owner`'s request. A different owner empties the pane. */
  | { type: "show"; owner: string | null }
  /** Empty the pane. The curl line stays unless `curl` is set. */
  | { type: "clear"; curl?: boolean }
  /** A send started. `sendId` is unique per send; the steps below carry it. */
  | { type: "start"; sendId: number }
  | { type: "curl"; sendId: number; curl: string }
  | { type: "response"; sendId: number; result: ResponseResult; validation: ValidationResult | null }
  | { type: "fail"; sendId: number; error: string }
  | { type: "done"; sendId: number }
  /** An error that isn't about a send, like saving a body. Always shown. */
  | { type: "error"; error: string };

export function paneReducer(pane: ResponsePane, action: PaneAction): ResponsePane {
  switch (action.type) {
    case "show":
      if (action.owner === null || action.owner === pane.owner) return pane;
      return { ...EMPTY_PANE, owner: action.owner };
    case "clear":
      return {
        ...pane,
        sendId: null,
        sending: false,
        result: null,
        validation: null,
        error: null,
        curl: action.curl ? null : pane.curl,
      };
    case "start":
      return { ...pane, sendId: action.sendId, sending: true, result: null, validation: null, error: null };
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
 * this keeps it from flashing up next to the new request.
 */
export function visiblePane(pane: ResponsePane, owner: string | null): ResponsePane {
  return owner === null || owner === pane.owner ? pane : { ...EMPTY_PANE, owner };
}
