import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { LibraryEntry } from "./library";

/**
 * `spec0://` links, such as an "Open in Studio" button on a web page:
 *
 *     spec0://open?spec=<url-encoded https URL of the spec>&name=<url-encoded display name>
 *
 * Any web page can trigger a link like this, and the user may not expect Studio
 * to do anything when it does. So a link is only ever a *suggestion*: it is
 * checked here, shown to the user with the host it would download from, and
 * nothing is fetched until they press Open. Rust (`src-tauri/src/deep_link.rs`)
 * only receives links and passes them on.
 */

export const SCHEME = "spec0:";

/** Longest spec URL we accept. Real ones are far shorter. */
export const MAX_SPEC_URL = 2048;

/** Longest display name we show. Longer names are cut, not refused. */
export const MAX_NAME = 80;

/** A link that passed every check, waiting for the user to say yes. */
export interface OpenRequest {
  /** The spec's address, normalised by the URL parser. */
  specUrl: string;
  /** Where the spec would be downloaded from, the thing the user is really agreeing to. */
  host: string;
  /** What the page called the API. Plain text, for display only. */
  name: string | null;
  /** Parameters the link carried that Studio doesn't know, and ignored. */
  ignored: string[];
}

export type DeepLink =
  | { kind: "open"; request: OpenRequest }
  /** Not something Studio does; ignored with a quiet notice. */
  | { kind: "ignored"; reason: string }
  /** Something Studio won't do, such as fetching from a private address. */
  | { kind: "refused"; reason: string };

/** Read a `spec0://` link. Never throws; never fetches anything. */
export function parseDeepLink(raw: string): DeepLink {
  let link: URL;
  try {
    link = new URL(raw.trim());
  } catch {
    return { kind: "refused", reason: "The link couldn't be read." };
  }
  if (link.protocol !== SCHEME) {
    return { kind: "refused", reason: "The link isn't a spec0:// link." };
  }

  // `spec0://open?…` puts the action in the host; accept a trailing slash too.
  const action = (link.host || link.pathname.replace(/^\/+/, "")).toLowerCase();
  const path = link.host ? link.pathname : "";
  if (action !== "open" || (path !== "" && path !== "/")) {
    return { kind: "ignored", reason: `Studio doesn't know the link action "${clip(action || raw, 40)}".` };
  }

  const params = link.searchParams;
  const specs = params.getAll("spec");
  if (specs.length === 0) return { kind: "refused", reason: "The link doesn't say which spec to open." };
  if (specs.length > 1) return { kind: "refused", reason: "The link names more than one spec." };
  if (params.getAll("name").length > 1) {
    return { kind: "refused", reason: "The link has more than one name." };
  }

  const spec = checkSpecUrl(specs[0]);
  if (!spec.ok) return { kind: "refused", reason: spec.reason };

  const ignored = [...new Set([...params.keys()].filter((key) => key !== "spec" && key !== "name"))];
  return {
    kind: "open",
    request: {
      specUrl: spec.url.href,
      host: spec.url.host,
      name: displayName(params.get("name")),
      ignored: ignored.map((key) => clip(key, 30)),
    },
  };
}

/**
 * Only an absolute `https:` URL on a public host. Plain `http` could be changed
 * on the way; `file:`, `data:` and `javascript:` aren't downloads at all; and a
 * web page must not be able to point Studio at the user's own machine or
 * network (`localhost`, `192.168.…`, `*.internal`) or carry credentials.
 */
export function checkSpecUrl(value: string): { ok: true; url: URL } | { ok: false; reason: string } {
  if (value.length > MAX_SPEC_URL) return { ok: false, reason: "The spec's address is too long." };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "The spec's address isn't a full URL." };
  }
  if (url.protocol !== "https:") {
    return { ok: false, reason: "The spec's address must start with https://." };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "The spec's address contains a user name or password." };
  }
  if (isPrivateHost(url.hostname)) {
    return { ok: false, reason: "The spec's address points at this computer or a private network." };
  }
  return { ok: true, url };
}

/**
 * Whether `hostname` (as the URL parser gives it) is this machine, a private
 * network, or a name that only means something inside one.
 *
 * The URL parser has already turned every IPv4 spelling (`0x7f.1`, `2130706433`)
 * into dotted decimal and IDNs into ASCII, so these checks see the real host.
 * It can't know what a public name resolves to; the confirmation dialog, which
 * shows the host, is the check for that.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return true;

  if (host.startsWith("[") && host.endsWith("]")) return isPrivateIpv6(host.slice(1, -1));
  const v4 = ipv4(host);
  if (v4) return isPrivateIpv4(v4);

  if (!host.includes(".")) return true; // `localhost`, `intranet`, `printer`
  return [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".intranet"].some((suffix) =>
    host.endsWith(suffix),
  );
}

function ipv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return null;
  const numbers = parts.map(Number);
  return numbers.every((n) => n <= 255) ? numbers : null;
}

function isPrivateIpv4([a, b]: number[]): boolean {
  return (
    a === 0 || // "this network"
    a === 10 ||
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, including cloud metadata services
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) || // protocol assignments
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast and reserved
  );
}

function isPrivateIpv6(address: string): boolean {
  const groups = expandIpv6(address);
  if (!groups) return true; // unreadable: refuse rather than guess
  if (groups.every((group) => group === 0)) return true; // ::
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true; // ::1
  const first = groups[0];
  if ((first & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0) return true; // link/site-local
  if ((first & 0xff00) === 0xff00) return true; // multicast
  // IPv4-mapped (::ffff:a.b.c.d) and the old IPv4-compatible form (::a.b.c.d).
  if (groups.slice(0, 5).every((group) => group === 0) && (groups[5] === 0xffff || groups[5] === 0)) {
    return isPrivateIpv4([groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff]);
  }
  return false;
}

/** Eight 16-bit groups, or null. Input is the URL parser's serialisation, so it's hex-only. */
function expandIpv6(address: string): number[] | null {
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const read = (part: string) => (part ? part.split(":") : []);
  const head = read(halves[0]);
  const tail = halves.length === 2 ? read(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (!all.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) return null;
  return all.map((group) => parseInt(group, 16));
}

/**
 * The page's name for the API, safe to show as plain text: control and
 * text-direction characters removed (they can make a name read as something
 * else), whitespace collapsed, length capped. Empty becomes null.
 */
export function displayName(value: string | null): string | null {
  if (value == null) return null;
  const cleaned = value
    .replace(/\s+/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
    .replace(/ {2,}/g, " ")
    .trim();
  return cleaned ? clip(cleaned, MAX_NAME) : null;
}

function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

/** The library entry already holding this exact spec URL, if any. */
export function existingEntry(request: OpenRequest, entries: LibraryEntry[]): LibraryEntry | null {
  return (
    entries.find(
      (entry) => entry.source.kind === "url" && sameUrl(entry.source.ref, request.specUrl),
    ) ?? null
  );
}

function sameUrl(stored: string, wanted: string): boolean {
  if (stored === wanted) return true;
  try {
    return new URL(stored).href === wanted;
  } catch {
    return false;
  }
}

/**
 * What pressing Open does, and the only place a link leads to a request. A spec
 * already in the library is opened from the saved copy, with no download (the
 * user can Refresh it as usual); anything else goes through the ordinary
 * add-from-URL path, exactly as if the user had pasted the URL into Open.
 */
export async function confirmOpen(
  request: OpenRequest,
  entries: LibraryEntry[],
  actions: {
    openEntry: (entry: LibraryEntry) => Promise<void>;
    addFromUrl: (url: string) => Promise<void>;
  },
): Promise<"opened" | "added"> {
  const existing = existingEntry(request, entries);
  if (existing) {
    await actions.openEntry(existing);
    return "opened";
  }
  await actions.addFromUrl(request.specUrl);
  return "added";
}

/** Take the links Rust has queued (at start, or since the last take). */
export async function takeDeepLinks(): Promise<string[]> {
  try {
    return await invoke<string[]>("deep_link_take");
  } catch {
    return [];
  }
}

/** Called when a link has been queued; take it with `takeDeepLinks`. */
export function onDeepLink(handler: () => void): Promise<UnlistenFn> {
  return listen("studio://deep-link", handler);
}
