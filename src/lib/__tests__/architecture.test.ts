/**
 * ARCHITECTURE.md names every Rust module and every file in src/lib. This
 * fails when a file is added (or renamed) without a line there, so the map
 * doesn't quietly fall behind the code.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
const map = readFileSync(root("ARCHITECTURE.md"), "utf8");
const named = (file: string) => map.includes(`\`${file}\``);

describe("ARCHITECTURE.md", () => {
  it("names every module in src-tauri/src", () => {
    const missing = readdirSync(root("src-tauri/src")).filter((f) => f.endsWith(".rs") && !named(f));
    expect(missing, "add a line for each to ARCHITECTURE.md").toEqual([]);
  });

  it("names every file in src/lib", () => {
    const missing = readdirSync(root("src/lib"), { withFileTypes: true })
      .filter((entry) => entry.isFile() && !named(entry.name))
      .map((entry) => entry.name);
    expect(missing, "add a line for each to ARCHITECTURE.md").toEqual([]);
  });
});
