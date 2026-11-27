import { describe, expect, it } from "vitest";
import { filterPackages, licenceCounts, loadLicences, type LicencedPackage } from "../licences";

const pkg = (name: string, license: string): LicencedPackage => ({ name, version: "1.0.0", license, texts: [] });
const PACKAGES = [pkg("@xyflow/react", "MIT"), pkg("elkjs", "EPL-2.0"), pkg("react", "MIT"), pkg("@tauri-apps/api", "Apache-2.0 OR MIT")];

describe("filterPackages", () => {
  it("keeps every package for a blank query", () => {
    expect(filterPackages(PACKAGES, "  ")).toEqual(PACKAGES);
  });

  it("matches the name or the licence, ignoring case", () => {
    expect(filterPackages(PACKAGES, "ELK").map((p) => p.name)).toEqual(["elkjs"]);
    expect(filterPackages(PACKAGES, "epl").map((p) => p.name)).toEqual(["elkjs"]);
    expect(filterPackages(PACKAGES, "mit").map((p) => p.name)).toEqual(["@xyflow/react", "react", "@tauri-apps/api"]);
  });
});

describe("licenceCounts", () => {
  it("counts each licence, most used first, then by name", () => {
    expect(licenceCounts(PACKAGES)).toEqual([
      ["MIT", 2],
      ["Apache-2.0 OR MIT", 1],
      ["EPL-2.0", 1],
    ]);
  });
});

describe("loadLicences", () => {
  const respond = (ok: boolean, body: unknown) =>
    (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;

  it("reads the list the build wrote", async () => {
    expect(await loadLicences(respond(true, PACKAGES))).toEqual(PACKAGES);
  });

  it("gives nothing when there is no list, or it isn't one", async () => {
    expect(await loadLicences(respond(false, null))).toBeUndefined();
    expect(await loadLicences(respond(true, { not: "a list" }))).toBeUndefined();
    expect(
      await loadLicences((async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch),
    ).toBeUndefined();
  });
});
