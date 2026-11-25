/**
 * The open-source packages built into Studio, as Settings → About lists them.
 *
 * The list is written at build time (scripts/third-party-notices.ts) from what
 * the bundle actually contains, and served next to the app.
 */

export const LICENCES_URL = "/third-party-notices.json";

export interface LicencedPackage {
  name: string;
  version: string;
  /** An SPDX expression, as the package declares it: `MIT`, `MIT OR Apache-2.0`. */
  license: string;
  homepage?: string;
  /** The licence and notice files the package ships, as written. */
  texts: string[];
}

/** Packages whose name or licence contains the query, ignoring case. Every package when it's blank. */
export function filterPackages(packages: LicencedPackage[], query: string): LicencedPackage[] {
  const q = query.trim().toLowerCase();
  if (!q) return packages;
  return packages.filter((p) => p.name.toLowerCase().includes(q) || p.license.toLowerCase().includes(q));
}

/** How many packages use each licence, most used first: `[["MIT", 95], ["ISC", 10], …]`. */
export function licenceCounts(packages: LicencedPackage[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const p of packages) counts.set(p.license, (counts.get(p.license) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Read the list the build wrote. Undefined when there is none, as in a development build. */
export async function loadLicences(fetcher: typeof fetch = fetch): Promise<LicencedPackage[] | undefined> {
  try {
    const response = await fetcher(LICENCES_URL);
    if (!response.ok) return undefined;
    const data: unknown = await response.json();
    return Array.isArray(data) ? (data as LicencedPackage[]) : undefined;
  } catch {
    return undefined;
  }
}
