import { describe, expect, it } from "vitest";
import { canHaveGitInfo, describeGit, refLabel, type GitInfo } from "../git";

const INFO: GitInfo = {
  branch: "feat/orders-v2",
  sha: "1defaac",
  subject: "add the cancel endpoint",
  committedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
  dirty: false,
  root: "/Users/dev/orders",
  path: "openapi/orders.yaml",
};

describe("canHaveGitInfo", () => {
  it("is true only for a file import with a path", () => {
    expect(canHaveGitInfo({ kind: "file", ref: "/Users/dev/orders/openapi.yaml" })).toBe(true);
  });

  it("is false for every source that has no file behind it", () => {
    expect(canHaveGitInfo({ kind: "url", ref: "https://example.com/openapi.yaml" })).toBe(false);
    expect(canHaveGitInfo({ kind: "spec0", ref: "spec0:abc-123" })).toBe(false);
    expect(canHaveGitInfo({ kind: "sample", ref: "sample" })).toBe(false);
    expect(canHaveGitInfo(undefined)).toBe(false);
    expect(canHaveGitInfo({ kind: "file", ref: "" })).toBe(false);
  });
});

describe("refLabel", () => {
  it("shows the branch", () => {
    expect(refLabel(INFO)).toBe("feat/orders-v2");
  });

  it("says so when HEAD is detached rather than inventing a branch", () => {
    expect(refLabel({ ...INFO, branch: null })).toBe("detached at 1defaac");
  });
});

describe("describeGit", () => {
  // The rule this protects: provenance describes the file on disk. A branch
  // name beside an API is one step from reading as "production runs this",
  // which Studio cannot know.
  it("talks about the file, never about a deployment", () => {
    const text = describeGit(INFO).toLowerCase();
    expect(text).toContain("this file");
    expect(text).not.toContain("deploy");
    expect(text).not.toContain("production");
    expect(text).not.toContain("running");
    expect(text).not.toContain("live");
  });

  it("names the branch, the commit and the subject", () => {
    const text = describeGit(INFO);
    expect(text).toContain("feat/orders-v2");
    expect(text).toContain("1defaac");
    expect(text).toContain("add the cancel endpoint");
  });

  // Otherwise the commit id would describe bytes that have since changed,
  // which is a confidently wrong provenance claim.
  it("says the commit does not describe the file when the file is modified", () => {
    const text = describeGit({ ...INFO, dirty: true });
    expect(text).toContain("uncommitted changes");
    expect(text).toContain("not that commit");
  });

  it("says nothing about uncommitted work when the file is clean", () => {
    expect(describeGit(INFO)).not.toContain("uncommitted");
  });

  it("copes with a commit date it cannot parse", () => {
    const text = describeGit({ ...INFO, committedAt: "" });
    expect(text).toContain("1defaac");
    expect(text).not.toContain("()");
  });
});
