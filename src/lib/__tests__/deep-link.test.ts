import { describe, expect, it, vi } from "vitest";
import {
  MAX_NAME,
  MAX_SPEC_URL,
  checkSpecUrl,
  confirmOpen,
  displayName,
  existingEntry,
  isPrivateHost,
  parseDeepLink,
  type OpenRequest,
} from "../deepLink";
import type { LibraryEntry } from "../library";

const SPEC = "https://registry.example.com/acme/checkout/openapi.yaml";

/** Built the same way as an "Open in Studio" button builds its link. */
function linkFor(spec: string, name?: string, extra = ""): string {
  const base = `spec0://open?spec=${encodeURIComponent(spec)}`;
  return `${base}${name === undefined ? "" : `&name=${encodeURIComponent(name)}`}${extra}`;
}

function openRequest(raw: string): OpenRequest {
  const link = parseDeepLink(raw);
  if (link.kind !== "open") throw new Error(`expected open, got ${link.kind}: ${link.reason}`);
  return link.request;
}

function refusedReason(raw: string): string {
  const link = parseDeepLink(raw);
  expect(link.kind).toBe("refused");
  return link.kind === "refused" ? link.reason : "";
}

describe("parseDeepLink", () => {
  it("reads an Open in Studio link", () => {
    const request = openRequest(linkFor(SPEC, "acme/checkout-api"));
    expect(request).toEqual({
      specUrl: SPEC,
      host: "registry.example.com",
      name: "acme/checkout-api",
      ignored: [],
    });
  });

  it("accepts a link without a name, and with a trailing slash", () => {
    expect(openRequest(linkFor(SPEC)).name).toBeNull();
    expect(openRequest(`spec0://open/?spec=${encodeURIComponent(SPEC)}`).specUrl).toBe(SPEC);
    expect(openRequest(`spec0:open?spec=${encodeURIComponent(SPEC)}`).specUrl).toBe(SPEC);
  });

  it("shows the host with its port", () => {
    expect(openRequest(linkFor("https://specs.example.com:8443/a.json")).host).toBe(
      "specs.example.com:8443",
    );
  });

  it("ignores unknown actions, without refusing loudly", () => {
    const link = parseDeepLink(`spec0://delete?spec=${encodeURIComponent(SPEC)}`);
    expect(link.kind).toBe("ignored");
    expect(parseDeepLink(`spec0://open/extra?spec=${encodeURIComponent(SPEC)}`).kind).toBe("ignored");
  });

  it("ignores unknown parameters and says which", () => {
    const request = openRequest(linkFor(SPEC, "x", "&autorun=1&token=abc&autorun=2"));
    expect(request.ignored).toEqual(["autorun", "token"]);
    expect(request.specUrl).toBe(SPEC);
  });

  it("refuses links that aren't spec0 links or can't be read", () => {
    refusedReason("https://example.com/?spec=x");
    refusedReason("not a url");
    refusedReason("");
  });

  it("refuses a link with no spec, or more than one", () => {
    expect(refusedReason("spec0://open?name=x")).toMatch(/which spec/);
    expect(refusedReason(`${linkFor(SPEC)}&spec=${encodeURIComponent(SPEC)}`)).toMatch(/more than one/);
    refusedReason(`${linkFor(SPEC, "a")}&name=b`);
  });

  it.each([
    ["plain http", "http://registry.example.com/openapi.yaml"],
    ["a local file", "file:///etc/passwd"],
    ["a data URL", "data:application/json,{}"],
    ["javascript", "javascript:alert(1)"],
    ["a relative path", "/openapi.yaml"],
    ["something unparseable", "https://"],
    ["a user name", "https://user@registry.example.com/openapi.yaml"],
    ["a password", "https://user:secret@registry.example.com/openapi.yaml"],
    ["localhost", "https://localhost/openapi.yaml"],
    ["localhost with a port", "https://localhost:8080/openapi.yaml"],
    ["a .localhost name", "https://api.localhost/openapi.yaml"],
    ["loopback", "https://127.0.0.1/openapi.yaml"],
    ["loopback spelled in hex", "https://0x7f.1/openapi.yaml"],
    ["loopback as a number", "https://2130706433/openapi.yaml"],
    ["10/8", "https://10.1.2.3/openapi.yaml"],
    ["172.16/12", "https://172.20.0.1/openapi.yaml"],
    ["192.168/16", "https://192.168.1.10/openapi.yaml"],
    ["link-local (cloud metadata)", "https://169.254.169.254/latest/meta-data"],
    ["carrier-grade NAT", "https://100.64.0.1/openapi.yaml"],
    ["0.0.0.0", "https://0.0.0.0/openapi.yaml"],
    ["IPv6 loopback", "https://[::1]/openapi.yaml"],
    ["IPv6 unique local", "https://[fd12:3456::1]/openapi.yaml"],
    ["IPv6 link-local", "https://[fe80::1]/openapi.yaml"],
    ["IPv4-mapped loopback", "https://[::ffff:127.0.0.1]/openapi.yaml"],
    ["a single-label name", "https://intranet/openapi.yaml"],
    ["an mDNS name", "https://printer.local/openapi.yaml"],
    ["an .internal name", "https://api.corp.internal/openapi.yaml"],
    ["a trailing-dot localhost", "https://localhost./openapi.yaml"],
    ["an overlong address", `https://registry.example.com/${"a".repeat(MAX_SPEC_URL)}`],
  ])("refuses a spec URL that is %s", (_label, spec) => {
    expect(parseDeepLink(linkFor(spec, "x")).kind).toBe("refused");
    expect(checkSpecUrl(spec).ok).toBe(false);
  });

  it("refuses a spec URL that wasn't encoded into the link but still names a private host", () => {
    expect(parseDeepLink("spec0://open?spec=https://127.0.0.1/a.json").kind).toBe("refused");
  });

  it("accepts public hosts, including public IP addresses", () => {
    for (const spec of [
      "https://petstore3.swagger.io/api/v3/openapi.json",
      "https://raw.githubusercontent.com/acme/api/main/openapi.yaml",
      "https://8.8.8.8/openapi.json",
      "https://[2001:4860:4860::8888]/openapi.json",
      "https://172.32.0.1/openapi.json",
    ]) {
      expect(checkSpecUrl(spec).ok, spec).toBe(true);
    }
  });

  it("shows an internationalised host in its ASCII form, so look-alike letters can't hide", () => {
    expect(openRequest(linkFor("https://\u0430pple.com/openapi.json")).host).toBe("xn--pple-43d.com");
  });
});

describe("isPrivateHost", () => {
  it("refuses unreadable IPv6 rather than guessing", () => {
    expect(isPrivateHost("[not:an:address::::]")).toBe(true);
    expect(isPrivateHost("")).toBe(true);
  });
});

describe("displayName", () => {
  it("keeps an ordinary name", () => {
    expect(displayName("acme/checkout-api")).toBe("acme/checkout-api");
  });

  it("treats markup as text (it is never rendered as HTML) and removes control characters", () => {
    expect(displayName("<img src=x onerror=alert(1)>")).toBe("<img src=x onerror=alert(1)>");
    expect(displayName("a\u0000b\nc\u202Egnp.exe")).toBe("ab cgnp.exe");
  });

  it("caps the length", () => {
    const name = displayName("x".repeat(500))!;
    expect([...name].length).toBe(MAX_NAME);
    expect(name.endsWith("…")).toBe(true);
  });

  it("turns an empty or missing name into null", () => {
    expect(displayName(null)).toBeNull();
    expect(displayName("   \u200b ")).toBeNull();
  });
});

function entry(id: string, kind: LibraryEntry["source"]["kind"], ref: string): LibraryEntry {
  return {
    id,
    title: id,
    version: "1.0.0",
    source: { kind, ref },
    operations: 1,
    schemas: 1,
    addedAt: "2026-01-01T00:00:00Z",
    openedAt: "2026-01-01T00:00:00Z",
  };
}

describe("confirmOpen", () => {
  const request = openRequest(linkFor(SPEC, "acme/checkout-api"));

  it("adds a new spec through the add-from-URL path", async () => {
    const addFromUrl = vi.fn(async () => {});
    const openEntry = vi.fn(async () => {});
    const result = await confirmOpen(request, [entry("other", "url", "https://other.example.com/a.json")], {
      addFromUrl,
      openEntry,
    });
    expect(result).toBe("added");
    expect(addFromUrl).toHaveBeenCalledExactlyOnceWith(SPEC);
    expect(openEntry).not.toHaveBeenCalled();
  });

  it("opens the saved copy of a spec already in the library, with no download", async () => {
    const saved = entry("saved", "url", SPEC);
    const addFromUrl = vi.fn(async () => {});
    const openEntry = vi.fn(async () => {});
    expect(await confirmOpen(request, [saved], { addFromUrl, openEntry })).toBe("opened");
    expect(openEntry).toHaveBeenCalledExactlyOnceWith(saved);
    expect(addFromUrl).not.toHaveBeenCalled();
  });

  it("matches only the same URL from a URL source", () => {
    expect(existingEntry(request, [entry("file", "file", SPEC)])).toBeNull();
    expect(existingEntry(request, [entry("near", "url", `${SPEC}?v=2`)])).toBeNull();
    expect(existingEntry(request, [entry("typed", "url", SPEC.replace("registry", "REGISTRY"))])?.id).toBe(
      "typed",
    );
  });

  it("does nothing until it is called: parsing a link never fetches", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    parseDeepLink(linkFor(SPEC, "x"));
    parseDeepLink(linkFor("http://127.0.0.1/a", "x"));
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });
});
