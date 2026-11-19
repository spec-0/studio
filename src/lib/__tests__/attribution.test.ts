import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../../scripts/check-attribution.mjs", import.meta.url));

/** Runs the CI check as CI does, and returns its exit code. */
function check(title: string, body: string): number {
  const run = spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, PR_TITLE: title, PR_BODY: body },
    encoding: "utf8",
  });
  return run.status ?? -1;
}

describe("the attribution check on pull requests", () => {
  it("rejects a Co-Authored-By line naming a model", () => {
    expect(check("Fix a bug", "Fixes it.\n\nCo-Authored-By: Claude <noreply@anthropic.com>")).toBe(1);
    expect(check("Fix a bug", "co-authored-by: GitHub Copilot <copilot@github.com>")).toBe(1);
  });

  it("rejects a Generated with footer", () => {
    expect(check("Fix a bug", "Generated with")).toBe(1);
    expect(check("Fix a bug", "🤖 Generated with [Claude Code](https://claude.com/claude-code)")).toBe(1);
    expect(check("Generated with ChatGPT", "")).toBe(1);
  });

  it("passes an ordinary pull request", () => {
    expect(check("Fix a bug", "Fixes the parser.\n\nCo-Authored-By: Ada Lovelace <ada@example.com>")).toBe(0);
    expect(check("Regenerate types", "The client was generated with openapi-typescript.")).toBe(0);
    expect(check("Docs", "")).toBe(0);
  });
});
