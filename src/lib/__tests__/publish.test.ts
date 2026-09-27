import { describe, expect, it } from "vitest";
import {
  API_NAME_PATTERN,
  buildPublishRequest,
  canPublish,
  deriveApiName,
  describeResult,
  validateApiName,
  whyNotPublishable,
} from "../publish";
import type { GitInfo } from "../git";

const CLEAN: GitInfo = {
  branch: "main",
  sha: "1defaac",
  subject: "add the cancel endpoint",
  committedAt: new Date().toISOString(),
  dirty: false,
  root: "/Users/dev/orders",
  path: "openapi/orders.yaml",
};

describe("canPublish", () => {
  it("allows a spec opened from a file", () => {
    expect(canPublish({ kind: "file", ref: "/Users/dev/orders/openapi.yaml" })).toBe(true);
  });

  // Studio has no editor, so a spec0-sourced document is byte-identical to what
  // the platform holds — the button would be a claim that isn't true.
  it("allows a spec opened from a URL: Studio holds its full text", () => {
    expect(canPublish({ kind: "url", ref: "https://example.com/o.yaml" })).toBe(true);
    expect(whyNotPublishable({ kind: "url", ref: "https://example.com/o.yaml" })).toBeNull();
  });

  it("refuses a spec0-sourced document and the sample", () => {
    expect(canPublish({ kind: "spec0", ref: "spec0:abc" })).toBe(false);
    expect(canPublish({ kind: "sample", ref: "sample" })).toBe(false);
    expect(canPublish(undefined)).toBe(false);
  });

  it("explains the refusal instead of going quiet", () => {
    expect(whyNotPublishable({ kind: "spec0", ref: "spec0:abc" })).toContain("already lives in spec0");
    expect(whyNotPublishable({ kind: "sample", ref: "sample" })).toContain("isn't a real API");
    expect(whyNotPublishable({ kind: "file", ref: "/x.yaml" })).toBeNull();
  });
});

describe("deriveApiName", () => {
  it("suggests a kebab-case name from a title", () => {
    expect(deriveApiName("Orders API")).toBe("orders-api");
    expect(deriveApiName("Payments (v2)")).toBe("payments-v2");
    expect(deriveApiName("  Spaced   Out  ")).toBe("spaced-out");
  });

  it("produces something the platform's own pattern accepts", () => {
    for (const title of ["Orders API", "ACME — Billing!", "a", "Ünicode Näme"]) {
      const name = deriveApiName(title);
      if (name) expect(API_NAME_PATTERN.test(name)).toBe(true);
    }
  });

  // An empty field a person must fill beats a confident guess like "api".
  it("returns nothing rather than inventing a name", () => {
    expect(deriveApiName("!!!")).toBe("");
    expect(deriveApiName("")).toBe("");
  });

  it("does not end on a dash after truncation", () => {
    const name = deriveApiName("x".repeat(60) + " " + "y".repeat(20));
    expect(name.endsWith("-")).toBe(false);
    expect(API_NAME_PATTERN.test(name)).toBe(true);
  });
});

describe("validateApiName", () => {
  it("accepts a good name", () => {
    expect(validateApiName("orders-api")).toBeNull();
  });

  it("rejects with a readable reason rather than letting the API 400", () => {
    expect(validateApiName("")).toContain("required");
    expect(validateApiName("Orders")).toContain("lower-case");
    expect(validateApiName("-orders")).toContain("starting and ending");
    expect(validateApiName("orders-")).toContain("starting and ending");
    expect(validateApiName("a".repeat(64))).toContain("63");
  });
});

describe("buildPublishRequest", () => {
  it("sends the document and the name", () => {
    const body = buildPublishRequest({ text: "openapi: 3.0.3", name: " orders-api " });
    expect(body.openapiSpec).toBe("openapi: 3.0.3");
    expect(body.name).toBe("orders-api");
  });

  it("omits empty optional fields rather than sending blanks", () => {
    const body = buildPublishRequest({ text: "x", name: "orders", team: "  ", version: "" });
    expect(body).not.toHaveProperty("team");
    expect(body).not.toHaveProperty("version");
    expect(body).not.toHaveProperty("gitSha");
  });

  it("carries provenance when the working file is clean", () => {
    const body = buildPublishRequest({ text: "x", name: "orders", git: CLEAN });
    expect(body.gitSha).toBe("1defaac");
    expect(body.githubBranch).toBe("main");
    expect(body.specFilePath).toBe("openapi/orders.yaml");
  });

  // The platform treats a matching gitSha as "nothing changed" and skips the
  // publish. A dirty file's commit does not describe its contents, so sending
  // it would both assert something false and suppress a real publish.
  it("withholds gitSha when the file has uncommitted changes", () => {
    const body = buildPublishRequest({ text: "x", name: "orders", git: { ...CLEAN, dirty: true } });
    expect(body).not.toHaveProperty("gitSha");
    // The branch and path still describe where the file is, and stay.
    expect(body.githubBranch).toBe("main");
    expect(body.specFilePath).toBe("openapi/orders.yaml");
  });

  it("never carries anything that isn't the document or its coordinates", () => {
    const body = buildPublishRequest({
      text: "x",
      name: "orders",
      team: "payments",
      version: "1.2.3",
      git: CLEAN,
    });
    expect(Object.keys(body).sort()).toEqual(
      ["githubBranch", "gitSha", "name", "openapiSpec", "specFilePath", "team", "version"].sort(),
    );
  });
});

describe("describeResult", () => {
  it("says when a new API was created", () => {
    const { tone, lines } = describeResult({
      created: true,
      versionCreated: true,
      apiName: "orders-api",
      version: "1.4.0",
      teamName: "Payments",
    });
    expect(tone).toBe("ok");
    expect(lines[0]).toContain("Created orders-api 1.4.0 in Payments");
  });

  it("says plainly when nothing was sent", () => {
    const { tone, lines } = describeResult({ noChanges: true, apiName: "orders-api" });
    expect(tone).toBe("note");
    expect(lines[0]).toContain("already up to date");
  });

  // The outcome that would otherwise pass as success while quietly replacing a
  // published version in place.
  it("surfaces an unchanged info.version as something to notice", () => {
    const { tone, lines } = describeResult({
      versionCreated: true,
      versionUnchanged: true,
      versionUnchangedHint: "info.version is still 1.4.0",
      apiName: "orders-api",
    });
    expect(tone).toBe("note");
    expect(lines.join(" ")).toContain("info.version is still 1.4.0");
  });

  it("falls back to its own wording when the platform sends no hint", () => {
    const { lines } = describeResult({ versionUnchanged: true, apiName: "orders-api" });
    expect(lines.join(" ")).toContain("replaced the existing version");
  });

  it("copes with a response that says almost nothing", () => {
    const { lines } = describeResult({});
    expect(lines[0]).toContain("the API");
  });
});
