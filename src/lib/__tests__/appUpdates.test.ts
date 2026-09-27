import { beforeEach, describe, expect, it, vi } from "vitest";

// Studio makes no request you didn't ask for. These tests pin the two things
// that promise rests on: the check at start is off unless explicitly turned on,
// and the check goes through the proxy the user configured.

const stored: Record<string, unknown> = {};
vi.mock("../store", () => ({
  STORE: { updates: "updates.json", connection: "connection.json" },
  readStore: async (name: string, fallback: unknown) => stored[name] ?? fallback,
  writeStore: async (name: string, value: unknown) => {
    stored[name] = value;
  },
}));

const { DEFAULT_UPDATE_PREFS, describeProgress, loadUpdatePrefs, saveUpdatePrefs, updateProxy } =
  await import("../appUpdates");
const { DEFAULT_CONNECTION } = await import("../connection");

beforeEach(() => {
  for (const key of Object.keys(stored)) delete stored[key];
});

describe("update preferences", () => {
  it("do not check at start by default", async () => {
    expect(DEFAULT_UPDATE_PREFS.checkOnStart).toBe(false);
    expect((await loadUpdatePrefs()).checkOnStart).toBe(false);
  });

  it("treat anything but an explicit true as off", async () => {
    stored["updates.json"] = { checkOnStart: "yes" };
    expect((await loadUpdatePrefs()).checkOnStart).toBe(false);
  });

  it("remember the choice once made", async () => {
    await saveUpdatePrefs({ checkOnStart: true });
    expect((await loadUpdatePrefs()).checkOnStart).toBe(true);
  });
});

describe("updateProxy", () => {
  it("leaves the environment in charge when nothing is configured", () => {
    expect(updateProxy(DEFAULT_CONNECTION)).toBeUndefined();
  });

  it("passes an explicit proxy and its bypass list", () => {
    const settings = { ...DEFAULT_CONNECTION, proxy: { url: "http://proxy:3128", noProxy: ".corp" } };
    expect(updateProxy(settings)).toEqual({ url: "http://proxy:3128", noProxy: ".corp" });
  });

  it("honours 'never use a proxy'", () => {
    const settings = { ...DEFAULT_CONNECTION, proxy: { url: "http://proxy:3128", disabled: true } };
    expect(updateProxy(settings)).toEqual({ disabled: true });
  });
});

describe("describeProgress", () => {
  it("shows a percentage when the size is known, megabytes when not", () => {
    expect(describeProgress({ downloaded: 50, total: 200 })).toBe("25%");
    expect(describeProgress({ downloaded: 3_200_000, total: null })).toBe("3.2 MB");
    expect(describeProgress(null)).toBe("");
  });
});
