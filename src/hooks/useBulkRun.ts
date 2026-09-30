import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { transportFor, type ConnectionSettings } from "../lib/connection";
import * as history from "../lib/history";
import type { HistoryEntry } from "../lib/history";
import { buildPlan, describeBody, send, type AuthState } from "../lib/request";
import { declaredResponse, storedResponseBody } from "../lib/response";
import { planRun, type RunOptions, type RunResult } from "../lib/runner";
import type { OperationSpec, ParsedSpec } from "../lib/spec";
import { sentToMock } from "../lib/targets";
import { validateResponse } from "../lib/validate";

/**
 * A bulk run: several operations against the current target, each response
 * checked against the spec. Required values come from the active environment;
 * see `lib/runner.ts` for what is skipped and why.
 */
export function useBulkRun({
  spec,
  server,
  auth,
  vars,
  mock,
  mockUrl,
  connection,
  currentId,
  environmentName,
  specFingerprint,
  setRequests,
}: {
  spec: ParsedSpec | null;
  server: string;
  auth: AuthState | null;
  vars: Record<string, string>;
  mock: { url: string; key?: string; bearer?: string } | null;
  mockUrl: string | null;
  connection: ConnectionSettings;
  /** The library entry whose cookie jar the run uses, and whose history it joins. */
  currentId: string | undefined;
  environmentName: string | undefined;
  specFingerprint: string | undefined;
  setRequests: Dispatch<SetStateAction<HistoryEntry[]>>;
}) {
  const [runResults, setRunResults] = useState<RunResult[]>([]);
  const [runningOp, setRunningOp] = useState<OperationSpec | null>(null);
  const [runScope, setRunScope] = useState("");
  const runCancel = useRef(false);

  /**
   * Run a set of operations and check each response against the spec.
   *
   * Sequential on purpose: a burst of concurrent requests at an internal service
   * is a load test nobody asked for. Results stream in as they land, so a long
   * run is watchable and can be stopped with partial results kept. An aborted
   * run that discarded what it had learned would be worse than not stopping.
   */
  const runOperations = useCallback(
    async (operations: OperationSpec[], options: RunOptions, scope: string) => {
      if (!spec) return;
      runCancel.current = false;
      setRunScope(scope);
      setRunResults([]);
      const runId = `run_${Date.now().toString(36)}`;
      const planned = planRun(operations, vars, options);
      const collected: RunResult[] = [];

      for (const item of planned) {
        if (runCancel.current) break;
        if (item.skip) {
          collected.push({ operation: item.operation, verdict: "skipped", skip: item.skip });
          setRunResults([...collected]);
          continue;
        }

        setRunningOp(item.operation);
        try {
          const plan = buildPlan(
            item.operation,
            server,
            item.pathParams,
            item.queryParams,
            {},
            auth,
            "",
            vars,
            mock,
          );
          const response = await send(plan, {
            ...transportFor(connection, plan.url),
            jar: currentId,
          });
          const declared = declaredResponse(item.operation.responses, response.status);
          const verdict = validateResponse(spec.doc, declared?.schema, response.json);
          collected.push({
            operation: item.operation,
            verdict: verdict.status,
            status: response.status,
            ms: response.ms,
            validation: verdict,
          });

          await history.record({
            method: item.operation.method,
            path: item.operation.path,
            url: plan.url,
            status: response.status,
            ms: response.ms,
            bytes: response.bytes,
            specTitle: spec.title,
            operationId: item.operation.id,
            apiId: currentId,
            environment: environmentName,
            headers: plan.headers,
            body: describeBody(plan.body),
            bodyKind: plan.body?.kind,
            ...history.checkFields(verdict, { version: spec.version, fingerprint: specFingerprint }),
            mock: sentToMock(plan.url, mockUrl),
            statusText: response.statusText,
            responseHeaders: response.headers,
            responseBody: storedResponseBody(response),
            runId,
          });
        } catch (error) {
          collected.push({
            operation: item.operation,
            verdict: "error",
            error: error instanceof Error ? error.message : String(error),
          });
        }
        setRunResults([...collected]);
      }

      setRunningOp(null);
      setRequests(await history.loadHistory());
    },
    [spec, server, auth, vars, mock, mockUrl, connection, currentId, environmentName, specFingerprint, setRequests],
  );

  /** Stop after the request in flight; results so far are kept. */
  const cancelRun = useCallback(() => {
    runCancel.current = true;
  }, []);

  return { runResults, runningOp, runScope, runOperations, cancelRun };
}
