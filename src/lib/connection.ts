import { readStore, writeStore, STORE } from "./store";

/**
 * How Studio reaches a host: certificate trust, proxy, timeout, redirects.
 *
 * Studio is built for **internal** APIs, which often sit behind a corporate
 * proxy on a certificate no public CA signed. A client that can't be told about
 * either can't reach them.
 *
 * **Certificate trust is per-host and deliberate.** There is no global "ignore
 * TLS errors" switch: it teaches people to stop reading warnings, and tends to
 * get left on, including against the public internet. Naming the host keeps the
 * decision scoped to what it was made for, and lets the UI say so at send time.
 */

export interface HostTrust {
  /** Hostname only, no scheme or port. Matching is exact and case-insensitive. */
  host: string;
  /**
   * Skip certificate verification for this host.
   *
   * The blunt instrument. Offered because sometimes there is genuinely no bundle
   * to hand. It is per-host, and the address bar says so whenever a request
   * is going somewhere it applies.
   */
  insecure?: boolean;
  /**
   * A private CA in PEM form, trusted *in addition to* the system roots.
   *
   * The safe path, and preferred: verification still happens, against a root the
   * user supplied. Stored as content rather than a path: the file dialog is the
   * consent step, and re-reading a path later would need a permission story that
   * buys nothing.
   */
  caBundlePem?: string;
  /** What the user picked, for display. Not used for reading. */
  caBundleName?: string;
}

export interface ProxySettings {
  /** Explicit proxy. Empty means "use the environment", which is the default. */
  url?: string;
  /** Hosts to bypass an explicit proxy for. */
  noProxy?: string;
  /** Bypass proxies entirely, including the environment's. */
  disabled?: boolean;
}

export interface ConnectionSettings {
  timeoutMs: number;
  followRedirects: boolean;
  proxy: ProxySettings;
  trusted: HostTrust[];
}

export const DEFAULT_TIMEOUT_MS = 30_000;

export const DEFAULT_CONNECTION: ConnectionSettings = {
  timeoutMs: DEFAULT_TIMEOUT_MS,
  followRedirects: true,
  proxy: {},
  trusted: [],
};

export async function loadConnection(): Promise<ConnectionSettings> {
  const stored = await readStore<Partial<ConnectionSettings>>(STORE.connection, {});
  return {
    timeoutMs:
      typeof stored.timeoutMs === "number" && stored.timeoutMs > 0
        ? stored.timeoutMs
        : DEFAULT_TIMEOUT_MS,
    followRedirects: stored.followRedirects !== false,
    proxy: stored.proxy ?? {},
    trusted: Array.isArray(stored.trusted) ? stored.trusted : [],
  };
}

export async function saveConnection(settings: ConnectionSettings): Promise<void> {
  await writeStore(STORE.connection, settings);
}

/** The hostname a URL targets, or null when it isn't a URL yet. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** The trust entry that applies to a URL, if any. */
export function trustFor(settings: ConnectionSettings, url: string): HostTrust | null {
  const host = hostOf(url);
  if (!host) return null;
  return settings.trusted.find((entry) => entry.host.toLowerCase() === host) ?? null;
}

/**
 * Is this request going somewhere with verification switched off?
 *
 * Separate from {@link trustFor} because supplying a CA bundle is *not* this: it
 * is still verification, and conflating the two would put a warning on the safe
 * option and train people to ignore it.
 */
export function isUnverified(settings: ConnectionSettings, url: string): boolean {
  return trustFor(settings, url)?.insecure === true;
}

/** Add or replace a host's trust decision. */
export function withTrust(settings: ConnectionSettings, trust: HostTrust): ConnectionSettings {
  const host = trust.host.trim().toLowerCase();
  if (!host) return settings;
  const others = settings.trusted.filter((entry) => entry.host.toLowerCase() !== host);
  // An entry that neither skips verification nor supplies a CA is not a decision;
  // dropping it keeps the list a record of things the user actually chose.
  const meaningful = trust.insecure || trust.caBundlePem;
  return { ...settings, trusted: meaningful ? [...others, { ...trust, host }] : others };
}

export function withoutTrust(settings: ConnectionSettings, host: string): ConnectionSettings {
  const needle = host.trim().toLowerCase();
  return { ...settings, trusted: settings.trusted.filter((e) => e.host.toLowerCase() !== needle) };
}

/** What the Rust side needs for one request, derived from settings plus the target. */
export function transportFor(settings: ConnectionSettings, url: string) {
  const trust = trustFor(settings, url);
  return {
    timeoutMs: settings.timeoutMs,
    followRedirects: settings.followRedirects,
    tls: trust ? { insecure: trust.insecure ?? false, caBundlePem: trust.caBundlePem } : undefined,
    proxy: settings.proxy.disabled
      ? { disabled: true }
      : settings.proxy.url
        ? { url: settings.proxy.url, noProxy: settings.proxy.noProxy }
        : undefined,
  };
}
