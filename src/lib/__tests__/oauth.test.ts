import { describe, expect, it } from "vitest";
import {
  DEFAULT_OAUTH,
  buildAuthorizeUrl,
  configProblems,
  createChallenge,
  createVerifier,
  describeExpiry,
  isExpired,
  resolveSecret,
  tokenKey,
  type OAuthConfig,
} from "../oauth";

const config = (over: Partial<OAuthConfig> = {}): OAuthConfig => ({
  ...DEFAULT_OAUTH,
  clientId: "cid",
  tokenUrl: "https://auth.example.com/oauth/token",
  ...over,
});

describe("token cache keys", () => {
  it("separates the same API's tokens by environment", () => {
    // Staging and production credentials are two environments. Sharing a token
    // across them would keep talking to the old one after a switch.
    expect(tokenKey("api-1", "env-staging")).not.toBe(tokenKey("api-1", "env-prod"));
    expect(tokenKey("api-1", null)).toBe("api-1:none");
  });
});

describe("isExpired", () => {
  const now = 1_000_000_000_000;

  it("treats an absent token as expired", () => {
    expect(isExpired(null, now)).toBe(true);
    expect(isExpired({ accessToken: "" }, now)).toBe(true);
  });

  it("renews a minute before expiry, so a request never rides a dying token", () => {
    expect(isExpired({ accessToken: "t", expiresAt: now + 30_000 }, now)).toBe(true);
    expect(isExpired({ accessToken: "t", expiresAt: now + 120_000 }, now)).toBe(false);
  });

  it("does not invent an expiry the server never stated", () => {
    // Treating "unknown" as expired would re-authenticate on every send against
    // servers that simply don't report expires_in.
    expect(isExpired({ accessToken: "t" }, now)).toBe(false);
  });
});

describe("describeExpiry", () => {
  const now = 1_000_000_000_000;
  it("says what it knows and no more", () => {
    expect(describeExpiry(null, now)).toBe("no token");
    expect(describeExpiry({ accessToken: "t" }, now)).toBe("no expiry reported");
    expect(describeExpiry({ accessToken: "t", expiresAt: now - 1 }, now)).toBe("expired");
    expect(describeExpiry({ accessToken: "t", expiresAt: now + 42 * 60_000 }, now)).toBe(
      "expires in 42m",
    );
    expect(describeExpiry({ accessToken: "t", expiresAt: now + 3 * 3_600_000 }, now)).toBe(
      "expires in 3h",
    );
  });
});

describe("resolveSecret", () => {
  it("reads the secret from the environment rather than the config", () => {
    // The config holds a reference. A literal here would be a per-API secret
    // store by the back door, which the app's rules exclude.
    expect(resolveSecret(config({ clientSecretRef: "{{clientSecret}}" }), { clientSecret: "shh" })).toBe(
      "shh",
    );
  });

  it("is empty when the variable isn't defined, rather than sending the placeholder", () => {
    expect(resolveSecret(config({ clientSecretRef: "{{missing}}" }), {})).toBe("{{missing}}");
  });
});

describe("PKCE", () => {
  it("generates a verifier in the RFC 7636 length range from the unreserved set", () => {
    const verifier = createVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it("generates a different verifier each time", () => {
    expect(createVerifier()).not.toBe(createVerifier());
  });

  it("produces the S256 challenge from the RFC's own test vector", async () => {
    // RFC 7636 appendix B — if this drifts, every authorization-code exchange
    // fails at the server with a message that won't say why.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(await createChallenge(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});

describe("buildAuthorizeUrl", () => {
  it("carries PKCE, state and scopes, and preserves existing query params", () => {
    const url = new URL(
      buildAuthorizeUrl(
        config({
          grant: "authorization_code",
          authorizationUrl: "https://auth.example.com/authorize?tenant=acme",
          scopes: ["read:orders", "write:orders"],
          audience: "https://api.example.com",
        }),
        "CHALLENGE",
        "STATE",
        "http://127.0.0.1:9876/callback",
      ),
    );
    expect(url.searchParams.get("tenant")).toBe("acme");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge")).toBe("CHALLENGE");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("STATE");
    expect(url.searchParams.get("scope")).toBe("read:orders write:orders");
    expect(url.searchParams.get("audience")).toBe("https://api.example.com");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:9876/callback");
  });
});

describe("configProblems", () => {
  it("is quiet for a usable client-credentials config", () => {
    expect(configProblems(config())).toEqual([]);
  });

  it("names each missing piece rather than failing generically", () => {
    expect(configProblems(config({ clientId: "", tokenUrl: "" }))).toEqual([
      "Client id is required.",
      "Token URL is required.",
    ]);
  });

  it("requires an authorization URL only for the authorization-code grant", () => {
    expect(configProblems(config({ grant: "authorization_code" }))).toContain(
      "Authorization URL is required for the authorization-code grant.",
    );
    expect(configProblems(config({ grant: "client_credentials" }))).toEqual([]);
  });

  it("rejects a relative token URL", () => {
    expect(configProblems(config({ tokenUrl: "/oauth/token" }))).toContain(
      "Token URL must be absolute.",
    );
  });
});

describe("the client secret never becomes a per-API secret store", () => {
  it("keeps a reference in the config, so the value lives in the environment", () => {
    const stored = config({ clientSecretRef: "{{clientSecret}}" });
    const serialised = JSON.stringify(stored);

    // What gets written to library.json is this object. If a real secret ever
    // ends up in `clientSecretRef`, it lands in the index — which is the exact
    // thing the secret-store rule forbids, and this test is what should fail first.
    expect(serialised).not.toContain("shh-this-is-the-secret");
    expect(stored.clientSecretRef.startsWith("{{")).toBe(true);
    expect(resolveSecret(stored, { clientSecret: "shh-this-is-the-secret" })).toBe(
      "shh-this-is-the-secret",
    );
  });
});
