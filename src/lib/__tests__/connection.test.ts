import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONNECTION,
  hostOf,
  isUnverified,
  transportFor,
  trustFor,
  withTrust,
  withoutTrust,
  type ConnectionSettings,
} from "../connection";

const base = (over: Partial<ConnectionSettings> = {}): ConnectionSettings => ({
  ...DEFAULT_CONNECTION,
  ...over,
});

describe("hostOf", () => {
  it("takes the hostname, ignoring scheme, port and path", () => {
    expect(hostOf("https://API.Internal.Example.com:8443/v1/orders")).toBe(
      "api.internal.example.com",
    );
  });

  it("is null for something that isn't a URL yet", () => {
    expect(hostOf("api.example.com")).toBeNull();
    expect(hostOf("")).toBeNull();
    expect(hostOf("{{baseUrl}}")).toBeNull();
  });
});

describe("trust decisions", () => {
  it("applies to the named host only", () => {
    const settings = withTrust(base(), { host: "internal.example.com", insecure: true });
    expect(trustFor(settings, "https://internal.example.com/v1")).not.toBeNull();
    // The whole reason trust is per-host: a decision made for one internal
    // service must not quietly cover the public internet.
    expect(trustFor(settings, "https://api.stripe.com/v1")).toBeNull();
    expect(trustFor(settings, "https://evil-internal.example.com/v1")).toBeNull();
  });

  it("matches case-insensitively and stores the host lowercased", () => {
    const settings = withTrust(base(), { host: "Internal.Example.COM", insecure: true });
    expect(settings.trusted[0].host).toBe("internal.example.com");
    expect(isUnverified(settings, "https://INTERNAL.example.com/x")).toBe(true);
  });

  it("replaces rather than duplicates a host's decision", () => {
    let settings = withTrust(base(), { host: "a.example.com", insecure: true });
    settings = withTrust(settings, { host: "a.example.com", caBundlePem: "PEM", insecure: false });
    expect(settings.trusted).toHaveLength(1);
    expect(settings.trusted[0].insecure).toBe(false);
    expect(settings.trusted[0].caBundlePem).toBe("PEM");
  });

  it("drops an entry that decides nothing", () => {
    // Neither skipping verification nor supplying a CA isn't a decision, and
    // keeping it would make the list look like trust had been granted.
    let settings = withTrust(base(), { host: "a.example.com", insecure: true });
    settings = withTrust(settings, { host: "a.example.com", insecure: false });
    expect(settings.trusted).toHaveLength(0);
  });

  it("removes a host on request", () => {
    const settings = withTrust(base(), { host: "a.example.com", insecure: true });
    expect(withoutTrust(settings, "A.Example.com").trusted).toHaveLength(0);
  });
});

describe("isUnverified", () => {
  it("is true only when verification is actually off", () => {
    const insecure = withTrust(base(), { host: "a.example.com", insecure: true });
    expect(isUnverified(insecure, "https://a.example.com")).toBe(true);
  });

  it("is false when a CA bundle was supplied, since that is still verification", () => {
    // Warning on the safe option is how you train someone to ignore the warning
    // that matters.
    const withCa = withTrust(base(), { host: "a.example.com", caBundlePem: "PEM" });
    expect(isUnverified(withCa, "https://a.example.com")).toBe(false);
  });

  it("is false for an unknown host and for a non-URL", () => {
    expect(isUnverified(base(), "https://unknown.example.com")).toBe(false);
    expect(isUnverified(base(), "{{baseUrl}}")).toBe(false);
  });
});

describe("transportFor", () => {
  it("carries the timeout and redirect preference", () => {
    const settings = base({ timeoutMs: 5_000, followRedirects: false });
    const transport = transportFor(settings, "https://a.example.com");
    expect(transport.timeoutMs).toBe(5_000);
    expect(transport.followRedirects).toBe(false);
  });

  it("sends no TLS options for a host with no decision", () => {
    // Absent, not `{insecure:false}`: the Rust side should take its own default
    // rather than be told to do what it already does.
    expect(transportFor(base(), "https://a.example.com").tls).toBeUndefined();
  });

  it("carries the CA bundle for a host trusted with one", () => {
    const settings = withTrust(base(), { host: "a.example.com", caBundlePem: "PEM" });
    const transport = transportFor(settings, "https://a.example.com/orders");
    expect(transport.tls).toEqual({ insecure: false, caBundlePem: "PEM" });
  });

  it("prefers disabling proxies over an explicit URL when both are set", () => {
    const settings = base({ proxy: { url: "http://proxy:3128", disabled: true } });
    expect(transportFor(settings, "https://a.example.com").proxy).toEqual({ disabled: true });
  });

  it("omits proxy config entirely when neither is set, so the environment applies", () => {
    expect(transportFor(base(), "https://a.example.com").proxy).toBeUndefined();
  });
});
