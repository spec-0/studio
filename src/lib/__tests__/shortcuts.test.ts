import { describe, expect, it } from "vitest";
import { sectionForKey } from "../navigation";
import { consoleShortcutLabel, isConsoleShortcut, sendTargetFor, tabShortcutFor, type KeyPress } from "../shortcuts";

describe("sendTargetFor", () => {
  it("sends the scratch request on the scratch screen", () => {
    expect(sendTargetFor("scratch")).toBe("scratch");
  });

  it("sends the selected operation when an API is open", () => {
    expect(sendTargetFor("api")).toBe("operation");
  });

  it("sends nothing from the library", () => {
    expect(sendTargetFor("library")).toBeNull();
  });

  it("sends nothing from the history list", () => {
    expect(sendTargetFor("history")).toBeNull();
  });

  it("sends nothing from Mocks, MCP or Settings", () => {
    expect(sendTargetFor("mocks")).toBeNull();
    expect(sendTargetFor("mcp")).toBeNull();
    expect(sendTargetFor("settings")).toBeNull();
  });
});

describe("tabShortcutFor", () => {
  const press = (key: string, mods: Partial<KeyPress> = {}, code = ""): KeyPress => ({
    key,
    code,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
  });
  const mac = { mac: true, menuClosesTabs: false };
  const macApp = { mac: true, menuClosesTabs: true };
  const other = { mac: false, menuClosesTabs: false };

  it("moves with Ctrl+Tab and Ctrl+Shift+Tab on every platform", () => {
    for (const platform of [mac, macApp, other]) {
      expect(tabShortcutFor(press("Tab", { ctrlKey: true }), platform)).toBe("next");
      expect(tabShortcutFor(press("Tab", { ctrlKey: true, shiftKey: true }), platform)).toBe("previous");
    }
    // A plain Tab still moves focus.
    expect(tabShortcutFor(press("Tab"), mac)).toBeNull();
    expect(tabShortcutFor(press("Tab", { shiftKey: true }), other)).toBeNull();
  });

  it("moves with ⌘⇧] and ⌘⇧[ on macOS, whatever character Shift makes", () => {
    expect(tabShortcutFor(press("}", { metaKey: true, shiftKey: true }, "BracketRight"), mac)).toBe("next");
    expect(tabShortcutFor(press("{", { metaKey: true, shiftKey: true }, "BracketLeft"), mac)).toBe("previous");
    expect(tabShortcutFor(press("}", { ctrlKey: true, shiftKey: true }, "BracketRight"), other)).toBeNull();
  });

  it("closes with ⌘W on macOS and Ctrl+W elsewhere", () => {
    expect(tabShortcutFor(press("w", { metaKey: true }), mac)).toBe("close");
    expect(tabShortcutFor(press("w", { ctrlKey: true }), other)).toBe("close");
    expect(tabShortcutFor(press("W", { ctrlKey: true }), other)).toBe("close");
    expect(tabShortcutFor(press("w", { ctrlKey: true, shiftKey: true }), other)).toBeNull();
    expect(tabShortcutFor(press("w"), other)).toBeNull();
  });

  it("leaves ⌘W to the menu in the macOS app, so one press can't close two tabs", () => {
    expect(tabShortcutFor(press("w", { metaKey: true }), macApp)).toBeNull();
  });

  it("doesn't take the API views' ⌘/Ctrl+1–4, or anything with Alt", () => {
    for (const key of ["1", "2", "3", "4"]) {
      expect(sectionForKey(key)).not.toBeNull();
      expect(tabShortcutFor(press(key, { metaKey: true }), mac)).toBeNull();
      expect(tabShortcutFor(press(key, { ctrlKey: true }), other)).toBeNull();
    }
    expect(tabShortcutFor(press("Tab", { ctrlKey: true, altKey: true }), other)).toBeNull();
  });
});

describe("isConsoleShortcut", () => {
  const press = (mods: Partial<KeyPress>, code = "KeyY", key = "Y"): KeyPress => ({
    key,
    code,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
  });

  it("is ⇧⌘Y on macOS and Ctrl+Shift+Y elsewhere, on the physical key", () => {
    expect(isConsoleShortcut(press({ metaKey: true, shiftKey: true }), { mac: true })).toBe(true);
    expect(isConsoleShortcut(press({ ctrlKey: true, shiftKey: true }), { mac: false })).toBe(true);
    // A layout where the key makes another character still matches.
    expect(isConsoleShortcut(press({ metaKey: true, shiftKey: true }, "KeyY", "Z"), { mac: true })).toBe(true);
  });

  it("doesn't take other combinations", () => {
    expect(isConsoleShortcut(press({ metaKey: true }), { mac: true })).toBe(false);
    expect(isConsoleShortcut(press({ ctrlKey: true, shiftKey: true }), { mac: true })).toBe(false);
    expect(isConsoleShortcut(press({ metaKey: true, shiftKey: true, altKey: true }), { mac: true })).toBe(false);
    expect(isConsoleShortcut(press({ ctrlKey: true, shiftKey: true }, "KeyD", "D"), { mac: false })).toBe(false);
  });

  it("is labelled for each platform", () => {
    expect(consoleShortcutLabel(true)).toBe("⇧⌘Y");
    expect(consoleShortcutLabel(false)).toBe("Ctrl+Shift+Y");
  });
});
