import type { HistoryEntry } from "./history";
import { extensionFor, type ResponseResult } from "./request";
import type { ResponseSpec } from "./spec";

/**
 * Small, pure steps around a response: which declared response it answers, what
 * of it goes into history, how a recorded one is shown again, and how a failed
 * send is worded.
 */

/**
 * The response the spec declares for a status code.
 *
 * An exact match wins, then the range (`4XX`), then `default`. Replaying a
 * history entry has always skipped the range step, so it passes
 * `{ ranges: false }` to keep that behaviour.
 */
export function declaredResponse(
  responses: ResponseSpec[],
  status: number,
  { ranges = true }: { ranges?: boolean } = {},
): ResponseSpec | undefined {
  return (
    responses.find((r) => r.status === String(status)) ??
    (ranges ? responses.find((r) => r.status === `${Math.floor(status / 100)}XX`) : undefined) ??
    responses.find((r) => r.status === "default")
  );
}

/**
 * The response body as history stores it.
 *
 * A 40MB PDF must not end up in history.json. Record that it happened and how
 * big it was; the bytes are already held in a temp file.
 */
export function storedResponseBody(response: ResponseResult): string {
  return response.binary
    ? `(${response.binary.contentType || "binary"} · ${response.binary.byteLength} bytes — not stored)`
    : response.bodyText;
}

/**
 * Rebuild a response from a history entry so it can be shown again.
 *
 * Null for entries recorded before responses were stored. A body that isn't JSON
 * is still shown as text; it just has no parsed value to check.
 */
export function responseFromHistory(entry: HistoryEntry): ResponseResult | null {
  if (entry.responseBody === undefined) return null;
  let json: unknown;
  try {
    json = entry.responseBody ? JSON.parse(entry.responseBody) : undefined;
  } catch {
    json = undefined;
  }
  return {
    status: entry.status,
    statusText: entry.statusText ?? "",
    headers: entry.responseHeaders ?? {},
    bodyText: entry.responseBody,
    json,
    ms: entry.ms,
    bytes: entry.bytes,
  };
}

/**
 * The message shown when a send throws.
 *
 * In the browser preview the usual cause is CORS, which the desktop build isn't
 * subject to, so the preview says so.
 */
export function describeSendError(error: unknown, desktop: boolean): string {
  return error instanceof Error
    ? `${error.message}${desktop ? "" : "\n\n(Browser preview — probably CORS. The desktop build sends from Rust and isn't subject to it.)"}`
    : String(error);
}

/**
 * The file name to offer when saving a response body: the server's
 * `Content-Disposition` name if it gave one, otherwise `response` plus an
 * extension for the content type.
 */
export function suggestedFileName(contentDisposition: string, contentType: string): string {
  const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(contentDisposition)?.[1];
  return named ?? `response${extensionFor(contentType)}`;
}
