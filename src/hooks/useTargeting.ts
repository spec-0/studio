import { useMemo } from "react";
import { isUnverified, type ConnectionSettings } from "../lib/connection";
import { interpolate } from "../lib/env";
import type { LibraryEntry } from "../lib/library";
import type { ParsedSpec } from "../lib/spec";
import { DEFAULT_API_URL, absoluteMockUrl, type Session } from "../lib/spec0";
import { environmentSkew, mockIsBehind } from "../lib/sync";
import {
  buildTargets,
  environmentFor,
  isTargetingMock,
  mockCredentials,
} from "../lib/targets";

/**
 * Everything derived from where the address bar points: the targets on offer,
 * the mock and how to authenticate to it, which platform environment is aimed
 * at and whether it runs the spec's version, and whether TLS is verified there.
 *
 * Pure derivation — no state of its own.
 */
export function useTargeting({
  session,
  current,
  spec,
  server,
  vars,
  connection,
}: {
  session: Session | null;
  current: LibraryEntry | null;
  spec: ParsedSpec | null;
  server: string;
  vars: Record<string, string>;
  connection: ConnectionSettings;
}) {
  /**
   * Resolve on read, not just on import: entries added before mock URLs were
   * absolutised still hold a bare path, and a stale library row shouldn't leave
   * the target selector inserting something that can't be sent.
   */
  const mockUrl = useMemo(
    () => absoluteMockUrl(session?.apiUrl ?? DEFAULT_API_URL, current?.mockUrl) ?? null,
    [current?.mockUrl, session?.apiUrl],
  );
  /** True when the mock serves an older contract than the spec we hold. */
  const mockBehind = useMemo(() => mockIsBehind(current ?? {}), [current]);

  /** Is the request about to be sent somewhere we've stopped verifying? */
  const unverifiedTarget = useMemo(
    () => isUnverified(connection, interpolate(server, vars)),
    [connection, server, vars],
  );

  const mock = useMemo(
    () => mockCredentials(mockUrl, current?.mockApiKey, session),
    [mockUrl, current?.mockApiKey, session],
  );

  /** True while the address bar is aimed at the mock — drives the key prompt. */
  const targetingMock = useMemo(
    () => isTargetingMock(interpolate(server, vars), mockUrl),
    [server, vars, mockUrl],
  );

  /** What the address bar can point at — see `buildTargets`. */
  const targets = useMemo(
    () => buildTargets(spec?.servers ?? [], mockUrl, current?.environments ?? []),
    [spec, mockUrl, current?.environments],
  );

  /** The platform environment currently being targeted, if any. */
  const activeEnvTarget = useMemo(
    () => environmentFor(current?.environments ?? [], interpolate(server, vars)),
    [current?.environments, server, vars],
  );

  /**
   * The environment serves a different version than the spec we hold.
   *
   * Worth saying plainly, because it explains a whole class of confusing results: a
   * request built from 1.5.0's schema against a host still running 1.4.0 can fail in
   * ways that look like the client is wrong.
   */
  const envVersionSkew = useMemo(
    () => environmentSkew(activeEnvTarget, spec?.version),
    [activeEnvTarget, spec?.version],
  );

  return {
    mockUrl,
    mock,
    mockBehind,
    unverifiedTarget,
    targetingMock,
    targets,
    envVersionSkew,
  };
}
