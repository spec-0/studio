import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { packageDir, readPackage, renderNotices } from "../third-party-notices";

describe("packageDir", () => {
  it("finds the package a bundled module comes from", () => {
    expect(packageDir("/app/node_modules/elkjs/lib/elk.bundled.js")).toBe("/app/node_modules/elkjs");
    expect(packageDir("/app/node_modules/@xyflow/react/dist/esm/index.js")).toBe("/app/node_modules/@xyflow/react");
  });

  it("takes the innermost package when one is nested in another", () => {
    expect(packageDir("/app/node_modules/a/node_modules/@b/c/index.js")).toBe("/app/node_modules/a/node_modules/@b/c");
  });

  it("ignores the app's own code, and strips query strings and virtual-module markers", () => {
    expect(packageDir("/app/src/App.tsx")).toBeUndefined();
    expect(packageDir("\0/app/node_modules/x/index.css?inline")).toBe("/app/node_modules/x");
  });
});

describe("readPackage", () => {
  const dir = (files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), "notices-"));
    const pkg = join(root, "node_modules", "pkg");
    mkdirSync(pkg, { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(join(pkg, name), text);
    return pkg;
  };

  it("reads the licence and every licence or notice file the package ships", () => {
    const pkg = readPackage(
      dir({
        "package.json": JSON.stringify({ name: "pkg", version: "1.2.3", license: "MIT OR Apache-2.0", repository: "git+https://github.com/o/pkg.git" }),
        "LICENSE-MIT": "mit text",
        "LICENSE-APACHE-2.0": "apache text",
        "NOTICE": "notice text",
        "README.md": "not a licence",
      }),
    )!;
    expect(pkg).toMatchObject({ name: "pkg", version: "1.2.3", license: "MIT OR Apache-2.0", homepage: "https://github.com/o/pkg" });
    expect(pkg.texts).toEqual(["apache text", "mit text", "notice text"]);
  });

  it("reads the old object form of the licence field", () => {
    const pkg = readPackage(dir({ "package.json": JSON.stringify({ name: "old", version: "0.1.0", license: { type: "BSD-3-Clause" } }) }))!;
    expect(pkg.license).toBe("BSD-3-Clause");
  });
});

describe("renderNotices", () => {
  it("lists every package first, then each one's texts, in name order", () => {
    const text = renderNotices([
      { name: "zed", version: "2.0.0", license: "MIT", texts: ["zed licence"] },
      { name: "elkjs", version: "0.11.1", license: "EPL-2.0", homepage: "https://github.com/kieler/elkjs", texts: ["EPL text"] },
    ]);
    const list = text.indexOf("elkjs 0.11.1  (EPL-2.0)");
    expect(list).toBeGreaterThan(0);
    expect(text.indexOf("zed 2.0.0  (MIT)")).toBeGreaterThan(list);
    expect(text.indexOf("EPL text")).toBeLessThan(text.indexOf("zed licence"));
    expect(text).toContain("Source: https://github.com/kieler/elkjs");
  });

  it("says so when a package ships no licence file", () => {
    expect(renderNotices([{ name: "bare", version: "1.0.0", license: "ISC", texts: [] }])).toContain(
      "This package ships no licence file. It is distributed under ISC.",
    );
  });
});
