import { useCallback, useMemo, useState } from "react";
import {
  activeEnvironment,
  effectiveVariables,
  saveEnvironments,
  withBaseUrl,
  type EnvironmentFile,
} from "../lib/env";

/**
 * Client environments: local sets of values for a testing scenario.
 *
 * They supply values, never destinations. See `lib/targets.ts` for where a
 * request goes.
 */
export function useEnvironments() {
  const [envFile, setEnvFile] = useState<EnvironmentFile>({ environments: [], activeId: null, shared: [] });

  const activeEnv = activeEnvironment(envFile);
  /** Shared variables, with the active environment's on top. */
  const vars = useMemo(() => effectiveVariables(envFile), [envFile]);

  /** Replace the whole file and write it. */
  const saveEnvFile = useCallback((next: EnvironmentFile) => {
    setEnvFile(next);
    void saveEnvironments(next);
  }, []);

  /** Keep an ad-hoc base URL as `baseUrl`. See `withBaseUrl`. */
  const saveTarget = useCallback((url: string) => {
    setEnvFile((prev) => {
      const next = withBaseUrl(prev, url);
      void saveEnvironments(next);
      return next;
    });
  }, []);

  return { envFile, setEnvFile, saveEnvFile, activeEnv, vars, saveTarget };
}
