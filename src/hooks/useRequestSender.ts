import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { RequestValues } from "../components/OperationView";
import type { SidebarTab } from "../components/Sidebar";
import { transportFor, type ConnectionSettings } from "../lib/connection";
import * as history from "../lib/history";
import type { HistoryEntry } from "../lib/history";
import {
  buildPlan,
  describeBody,
  inTauri,
  send,
  toCurl,
  type AuthState,
  type ResponseResult,
} from "../lib/request";
import {
  declaredResponse,
  describeSendError,
  responseFromHistory,
  storedResponseBody,
  suggestedFileName,
} from "../lib/response";
import {
  SCRATCH_OPERATION_ID,
  SCRATCH_TITLE,
  buildScratchPlan,
  padFromHistory,
  scratchPath,
  type ScratchPad,
} from "../lib/scratch";
import type { OperationSpec, ParsedSpec } from "../lib/spec";
import { pickSaveTarget, saveResponseTo } from "../lib/store";
import { sentToMock } from "../lib/targets";
import { validateResponse, type ValidationResult } from "../lib/validate";
import type { Settings } from "./useSettings";
import type { MainView, ReplayValues } from "./useWorkspace";

interface Options {
  spec: ParsedSpec | null;
  operation: OperationSpec | null;
  server: string;
  auth: AuthState | null;
  vars: Record<string, string>;
  mock: { url: string; key?: string; bearer?: string } | null;
  mockUrl: string | null;
  connection: ConnectionSettings;
  /** The library entry whose cookie jar a spec request uses. */
  currentId: string | undefined;
  /** The OAuth token to send, renewed first if it's close to expiring. */
  usableToken: () => Promise<string>;
  pad: ScratchPad;
  updatePad: (next: ScratchPad) => void;
  patchSettings: (patch: Partial<Settings>) => void;
  setRequests: Dispatch<SetStateAction<HistoryEntry[]>>;
  /** Workspace setters a replay moves. */
  setOperation: (op: OperationSpec) => void;
  setReplay: (values: ReplayValues | null) => void;
  setViewingRecord: (entry: HistoryEntry | null) => void;
  setTab: (tab: SidebarTab) => void;
  setView: (view: MainView) => void;
  setServer: (server: string) => void;
}

/**
 * Sending requests and showing what came back.
 *
 * Owns the response pane: the result, its schema check, the error, the curl
 * line. Spec requests, the scratch request and history replays all write to it.
 */
export function useRequestSender({
  spec,
  operation,
  server,
  auth,
  vars,
  mock,
  mockUrl,
  connection,
  currentId,
  usableToken,
  pad,
  updatePad,
  patchSettings,
  setRequests,
  setOperation,
  setReplay,
  setViewingRecord,
  setTab,
  setView,
  setServer,
}: Options) {
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<ResponseResult | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [curl, setCurl] = useState<string | null>(null);

  const values = useRef<RequestValues>({ pathParams: {}, queryParams: {}, headerParams: {}, body: "" });
  const onValuesChange = useCallback((next: RequestValues) => {
    values.current = next;
  }, []);

  /** Empty the response pane. The curl line stays unless `curl` is set. */
  const clearResponse = useCallback(({ curl = false }: { curl?: boolean } = {}) => {
    setResult(null);
    setValidation(null);
    setRequestError(null);
    if (curl) setCurl(null);
  }, []);

  const doSend = useCallback(async () => {
    if (!spec || !operation || !server.trim()) return;
    setSending(true);
    setRequestError(null);
    setResult(null);
    setValidation(null);
    // Whatever comes back is live, so the panes are no longer showing a record.
    setViewingRecord(null);
    try {
      const { pathParams, queryParams, headerParams, body } = values.current;
      // An OAuth "value" isn't typed by the user — it's the acquired token,
      // resolved (and renewed if needed) at the moment of sending.
      const effectiveAuth =
        auth?.type === "oauth2" ? { ...auth, value: await usableToken() } : auth;
      const plan = buildPlan(
        operation,
        server,
        pathParams,
        queryParams,
        headerParams,
        effectiveAuth,
        body,
        vars,
        mock,
      );
      setCurl(toCurl(plan));
      const response = await send(plan, {
        ...transportFor(connection, plan.url),
        // Cookies are per-API, keyed by the library entry, so a session picked
        // up here is never offered to a different API's host.
        jar: currentId,
      });
      setResult(response);

      const declared = declaredResponse(operation.responses, response.status);
      const verdict = validateResponse(spec.doc, declared?.schema, response.json);
      setValidation(verdict);
      patchSettings({ inspectorOpen: true });

      setRequests(
        await history.record({
          method: operation.method,
          path: operation.path,
          url: plan.url,
          status: response.status,
          ms: response.ms,
          bytes: response.bytes,
          specTitle: spec.title,
          operationId: operation.id,
          headers: plan.headers,
          body: describeBody(plan.body),
          bodyKind: plan.body?.kind,
          validation: verdict.status,
          mock: sentToMock(plan.url, mockUrl),
          statusText: response.statusText,
          responseHeaders: response.headers,
          responseBody: storedResponseBody(response),
        }),
      );
    } catch (error) {
      setRequestError(describeSendError(error, inTauri));
    } finally {
      setSending(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, operation, server, auth, vars, mockUrl, mock, connection, currentId, usableToken]);

  /**
   * Write the held response body wherever the user asks.
   *
   * A copy of the temp file Rust already wrote, not a second request — the bytes
   * were kept precisely so saving them doesn't mean fetching them again.
   */
  const saveResponseBody = useCallback(async (contentType: string) => {
    const path = result?.binary?.path;
    if (!path) return;
    const disposition = result?.headers?.["content-disposition"] ?? "";
    const target = await pickSaveTarget(suggestedFileName(disposition, contentType));
    if (!target) return;
    try {
      await saveResponseTo(path, target);
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : String(error));
    }
  }, [result]);

  /**
   * Send the scratch request.
   *
   * Deliberately a sibling of `doSend` rather than a branch inside it: there is
   * no operation, no declared response and nothing to validate, so every step
   * that makes `doSend` worth having is absent here. Folding them together would
   * mean threading "…unless there's no spec" through all of it.
   */
  const doScratchSend = useCallback(async () => {
    setSending(true);
    setRequestError(null);
    setResult(null);
    setValidation(null);
    try {
      const plan = buildScratchPlan(pad, vars);
      setCurl(toCurl(plan));
      // The scratch pad gets its own jar: it isn't an API and shouldn't borrow
      // one's session, nor leak a login it performed into a real API's.
      const response = await send(plan, { ...transportFor(connection, plan.url), jar: "__scratch__" });
      setResult(response);
      patchSettings({ inspectorOpen: true });

      setRequests(
        await history.record({
          method: plan.method,
          path: scratchPath(plan.url),
          url: plan.url,
          status: response.status,
          ms: response.ms,
          bytes: response.bytes,
          specTitle: SCRATCH_TITLE,
          operationId: SCRATCH_OPERATION_ID,
          headers: plan.headers,
          body: describeBody(plan.body),
          bodyKind: plan.body?.kind,
          validation: "no_schema",
          statusText: response.statusText,
          responseHeaders: response.headers,
          responseBody: storedResponseBody(response),
        }),
      );
    } catch (error) {
      setRequestError(describeSendError(error, inTauri));
    } finally {
      setSending(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pad, vars, connection]);

  const replayScratch = useCallback(
    (entry: HistoryEntry) => {
      updatePad(padFromHistory(entry));
      setRequestError(null);
      setValidation(null);
      setResult(responseFromHistory(entry));
    },
    [updatePad],
  );

  /**
   * Open a recorded call: restore the request *and* show what came back.
   *
   * Clicking history used to jump to the operation with the inputs restored but
   * an empty response pane, which loses the thing you clicked for. The recorded
   * response is re-rendered — including its schema check — and the entry stays
   * one Send away from being run again.
   */
  const doReplay = useCallback(
    (entry: HistoryEntry) => {
      if (!spec) return;
      const found = spec.operations.find((op) => op.id === entry.operationId);
      if (!found) {
        // Used to `return` silently, so clicking the row did nothing at all and
        // looked broken. A spec sync makes this ordinary rather than rare.
        setRequestError(
          `${entry.operationId} is no longer in this spec, so it can't be replayed. ` +
            `It was recorded on ${new Date(entry.at).toLocaleString()} and returned ${entry.status}.`,
        );
        setResult(null);
        setValidation(null);
        patchSettings({ inspectorOpen: true });
        return;
      }
      setOperation(found);
      // Path and query values live only inside the recorded URL; without pulling
      // them back out the form shows blank fields beside the response they
      // produced.
      const { pathParams, queryParams } = history.paramsFromEntry(entry, found.path);
      setReplay({ headers: entry.headers, body: entry.body, pathParams, queryParams });
      setViewingRecord(entry);
      setTab("operations");
      setView("operation");
      try {
        const parsed = new URL(entry.url);
        setServer(`${parsed.protocol}//${parsed.host}`);
      } catch {
        /* keep the current base URL */
      }

      const recorded = responseFromHistory(entry);
      if (!recorded) {
        // Recorded before responses were stored — say so instead of showing nothing.
        setResult(null);
        setValidation(null);
        setRequestError(
          `Recorded ${entry.status} in ${entry.ms}ms, but this entry predates response capture. Send again to see the body.`,
        );
        return;
      }

      setRequestError(null);
      setResult(recorded);

      const declared = declaredResponse(found.responses, entry.status, { ranges: false });
      setValidation(validateResponse(spec.doc, declared?.schema, recorded.json));
      patchSettings({ inspectorOpen: true });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [spec],
  );

  return {
    sending,
    result,
    validation,
    requestError,
    curl,
    onValuesChange,
    clearResponse,
    doSend,
    saveResponseBody,
    doScratchSend,
    replayScratch,
    doReplay,
  };
}
