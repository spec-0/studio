import { describe, expect, it } from "vitest";
import {
  agentLabel,
  blockedBy,
  decide,
  DEFAULT_AGENT_RULES,
  isLocalHostname,
  NO_GRANTS,
  normaliseHostPattern,
  normaliseRules,
  overCapMessage,
  RateLimit,
  requestHost,
  withAnswer,
  type Decision,
} from "../agentPolicy";

const rules = (blockedHosts: string[] = []) => ({ ...DEFAULT_AGENT_RULES, blockedHosts });
const ask = (decision: Decision) => {
  if (decision.kind !== "ask") throw new Error(`expected ask, got ${decision.kind}`);
  return decision;
};

describe("hosts", () => {
  it("knows which hosts are on this computer", () => {
    for (const host of ["localhost", "LOCALHOST", "api.localhost", "127.0.0.1", "127.1.2.3", "::1", "[::1]"]) {
      expect(isLocalHostname(host), host).toBe(true);
    }
    for (const host of ["example.com", "localhost.example.com", "10.0.0.1", "192.168.1.5", "0.0.0.0", "128.0.0.1"]) {
      expect(isLocalHostname(host), host).toBe(false);
    }
  });

  it("keys a host by name and port, with the default port written out", () => {
    expect(requestHost("http://localhost:8080/orders")).toMatchObject({ key: "localhost:8080", local: true });
    expect(requestHost("https://API.example.com/v1")).toMatchObject({ key: "api.example.com:443", local: false });
    expect(requestHost("http://[::1]:4010/")).toMatchObject({ key: "[::1]:4010", hostname: "::1", local: true });
    expect(requestHost("ftp://example.com/")).toBeNull();
    expect(requestHost("not a url")).toBeNull();
  });

  it("cleans up blocked-host entries and refuses what isn't a host", () => {
    expect(normaliseHostPattern(" https://API.Example.com/v1?x=1 ")).toBe("api.example.com");
    expect(normaliseHostPattern("*.prod.example.com")).toBe("*.prod.example.com");
    expect(normaliseHostPattern("example.com:8443")).toBe("example.com:8443");
    expect(normaliseHostPattern("")).toBeNull();
    expect(normaliseHostPattern("not a host")).toBeNull();
    expect(normaliseHostPattern(".example.com")).toBeNull();
  });

  it("matches blocked hosts exactly, by domain with *., and by port", () => {
    const patterns = ["api.example.com", "*.prod.example.com", "staging.example.com:8443"];
    expect(blockedBy("https://api.example.com/x", patterns)).toBe("api.example.com");
    expect(blockedBy("https://other.example.com/x", patterns)).toBeNull();
    expect(blockedBy("https://prod.example.com/x", patterns)).toBe("*.prod.example.com");
    expect(blockedBy("https://eu.prod.example.com/x", patterns)).toBe("*.prod.example.com");
    expect(blockedBy("https://notprod.example.com/x", patterns)).toBeNull();
    expect(blockedBy("https://staging.example.com:8443/x", patterns)).toBe("staging.example.com:8443");
    expect(blockedBy("https://staging.example.com/x", patterns)).toBeNull();
  });

  it("keeps stored rules within bounds", () => {
    expect(normaliseRules(undefined)).toEqual(DEFAULT_AGENT_RULES);
    expect(normaliseRules({ blockedHosts: ["A.com", "a.com", "nope nope"], maxRequestsPerMinute: 0 })).toEqual({
      blockedHosts: ["a.com"],
      maxRequestsPerMinute: 1,
    });
    expect(normaliseRules({ maxRequestsPerMinute: 1e9 }).maxRequestsPerMinute).toBe(600);
  });
});

describe("deciding", () => {
  it("asks the first time, and a session answer covers the host after that", () => {
    const first = ask(decide({ method: "GET", url: "http://localhost:8080/orders" }, NO_GRANTS, rules()));
    expect(first.changing).toBe(false);
    const grants = withAnswer(NO_GRANTS, first, "session");
    expect(decide({ method: "GET", url: "http://localhost:8080/orders/1" }, grants, rules())).toEqual({ kind: "allow" });
    // On this computer, a session answer covers every method.
    expect(decide({ method: "DELETE", url: "http://localhost:8080/orders/1" }, grants, rules())).toEqual({ kind: "allow" });
    // Another port is another host.
    expect(decide({ method: "GET", url: "http://localhost:9090/" }, grants, rules()).kind).toBe("ask");
  });

  it("'once' and 'deny' don't change what is allowed", () => {
    const first = ask(decide({ method: "GET", url: "http://localhost:8080/" }, NO_GRANTS, rules()));
    expect(withAnswer(NO_GRANTS, first, "once")).toBe(NO_GRANTS);
    expect(withAnswer(NO_GRANTS, first, "deny")).toBe(NO_GRANTS);
  });

  it("asks separately for DELETE, PUT and PATCH to a host outside this computer", () => {
    const read = ask(decide({ method: "GET", url: "https://api.example.com/orders" }, NO_GRANTS, rules()));
    const grants = withAnswer(NO_GRANTS, read, "session");
    expect(decide({ method: "POST", url: "https://api.example.com/orders" }, grants, rules())).toEqual({ kind: "allow" });
    for (const method of ["DELETE", "put", "PATCH"]) {
      const changing = ask(decide({ method, url: "https://api.example.com/orders/1" }, grants, rules()));
      expect(changing.changing).toBe(true);
    }
    const write = ask(decide({ method: "DELETE", url: "https://api.example.com/orders/1" }, grants, rules()));
    const both = withAnswer(grants, write, "session");
    expect(decide({ method: "PATCH", url: "https://api.example.com/orders/1" }, both, rules())).toEqual({ kind: "allow" });
  });

  it("refuses a blocked host without asking, even one already allowed", () => {
    const first = ask(decide({ method: "GET", url: "https://api.example.com/" }, NO_GRANTS, rules()));
    const grants = withAnswer(NO_GRANTS, first, "session");
    const decision = decide({ method: "GET", url: "https://api.example.com/" }, grants, rules(["api.example.com"]));
    expect(decision.kind).toBe("refuse");
    expect(decision.kind === "refuse" && decision.reason).toMatch(/blocked/);
  });

  it("refuses anything that isn't http or https", () => {
    expect(decide({ method: "GET", url: "file:///etc/passwd" }, NO_GRANTS, rules()).kind).toBe("refuse");
  });
});

describe("the cap", () => {
  it("allows the cap per sliding minute, then says how long to wait", () => {
    const limit = new RateLimit(() => 3);
    expect(limit.take(0)).toBe(0);
    expect(limit.take(10_000)).toBe(0);
    expect(limit.take(20_000)).toBe(0);
    expect(limit.take(30_000)).toBe(30_000);
    // The first request leaves the window after a minute.
    expect(limit.take(60_001)).toBe(0);
    limit.reset();
    expect(limit.take(60_002)).toBe(0);
    expect(overCapMessage(60, 1500)).toMatch(/60 a minute.*2 seconds/);
  });
});

describe("names", () => {
  it("names known agents readably and keeps others as they are", () => {
    expect(agentLabel({ name: "claude-code" })).toBe("Claude Code");
    expect(agentLabel({ name: "Cursor" })).toBe("Cursor");
    expect(agentLabel({ name: "my-agent" })).toBe("my-agent");
    expect(agentLabel({ name: null })).toBe("An unnamed agent");
    expect(agentLabel(undefined)).toBe("An unnamed agent");
  });
});
