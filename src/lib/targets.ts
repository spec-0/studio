/**
 * Where a request can go, and what to send when it goes to the mock.
 *
 * Headless so the rules below are testable without React: which destinations the
 * address bar offers, which platform environment a typed URL is, whether the
 * address bar is aimed at the mock, and when the session token may go with it.
 */

export interface Target {
  label: string;
  url: string;
  kind: "server" | "mock" | "env";
}

/** A platform environment: a place the API runs, as reported by the platform. */
export interface EnvironmentTarget {
  name: string;
  url: string;
  currentVersion?: string | null;
}

const trimSlash = (url: string) => url.replace(/\/$/, "");

/**
 * What the address bar can point at.
 *
 * Targets belong to the API — its declared servers, its hosted mock, the platform
 * environments it's deployed to — plus whatever the user types.
 *
 * *Client* environments are deliberately absent: they supply values, not
 * destinations. A platform environment is the opposite thing with an
 * unfortunately similar name — an actual place the API runs, reported by spec0,
 * so it belongs here and its variables do not.
 *
 * None of these is ever auto-selected. The initial value stays the spec's own
 * first server, because that is the document's declaration rather than a choice
 * made on the developer's behalf; where a request goes is theirs to pick.
 */
export function buildTargets(
  servers: string[],
  mockUrl: string | null,
  environments: EnvironmentTarget[],
): Target[] {
  const list: Target[] = [];
  for (const url of servers) {
    let label = url;
    try {
      const parsed = new URL(url);
      label = parsed.host + (parsed.pathname === "/" ? "" : parsed.pathname);
    } catch {
      /* a templated server URL — show it verbatim */
    }
    list.push({ label, url, kind: "server" });
  }
  if (mockUrl) list.push({ label: "Mock server", url: mockUrl, kind: "mock" });
  // Order is the platform's — its promotion order — and is preserved as received.
  for (const env of environments) {
    list.push({ label: env.name, url: env.url, kind: "env" });
  }
  return list.filter((t, i, all) => all.findIndex((o) => o.url === t.url) === i);
}

/**
 * The environment currently being targeted, if any.
 *
 * Matched on URL rather than tracked as separate state, so typing an environment's
 * URL by hand is recognised as that environment — which is what a developer means
 * when they do it. `resolved` is the address bar with variables already filled in.
 */
export function environmentFor<T extends EnvironmentTarget>(
  environments: T[],
  resolved: string,
): T | null {
  const url = trimSlash(resolved);
  if (!url) return null;
  return environments.find((env) => trimSlash(env.url) === url) ?? null;
}

/** True while the address bar (variables filled in) is aimed at the mock. */
export function isTargetingMock(resolved: string, mockUrl: string | null): boolean {
  if (!mockUrl) return false;
  const url = trimSlash(resolved);
  return url !== "" && url === trimSlash(mockUrl);
}

/** True when a sent URL went to the mock. Used to mark history entries. */
export function sentToMock(url: string, mockUrl: string | null): boolean {
  return Boolean(mockUrl && url.startsWith(trimSlash(mockUrl)));
}

/**
 * How to authenticate against the hosted mock.
 *
 * The platform session token is only offered when the mock is served from the
 * *same origin* we already send that token to. A mock URL is data that arrived
 * over the network; attaching the user's credentials to whatever host it names
 * would be a credential leak, so the origin check is a hard gate, not a tidy-up.
 */
export function mockCredentials(
  mockUrl: string | null,
  key: string | undefined,
  session: { apiUrl: string; token: string } | null,
): { url: string; key?: string; bearer?: string } | null {
  if (!mockUrl) return null;
  let sameOrigin = false;
  try {
    sameOrigin = Boolean(session) && new URL(mockUrl).origin === new URL(session!.apiUrl).origin;
  } catch {
    sameOrigin = false;
  }
  return {
    url: mockUrl,
    key,
    bearer: sameOrigin ? session?.token : undefined,
  };
}
