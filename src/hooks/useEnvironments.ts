import { useCallback, useMemo, useState } from "react";
import {
  saveEnvironments,
  variableMap,
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
  const [envFile, setEnvFile] = useState<EnvironmentFile>({ environments: [], activeId: null });

  const activeEnv = envFile.environments.find((env) => env.id === envFile.activeId) ?? null;
  const vars = useMemo(() => variableMap(activeEnv), [activeEnv]);

  /** Replace the whole file and write it. */
  const saveEnvFile = useCallback((next: EnvironmentFile) => {
    setEnvFile(next);
    void saveEnvironments(next);
  }, []);

  /** Keep an ad-hoc base URL as `baseUrl` in the active environment. See `withBaseUrl`. */
  const saveTarget = useCallback((url: string) => {
    setEnvFile((prev) => {
      const next = withBaseUrl(prev, url);
      void saveEnvironments(next);
      return next;
    });
  }, []);

  return { envFile, setEnvFile, saveEnvFile, activeEnv, vars, saveTarget };
}
