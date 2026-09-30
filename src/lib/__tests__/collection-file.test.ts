import { describe, expect, it } from "vitest";
import { newCollection, serializeCollection, textHash, type Collection } from "../collection";
import { canOverwrite, fromDisk, keepMine, reconcile, withCollectionSuffix } from "../collectionFile";

const PATH = "/repo/flows/checkout.spec0-collection.yaml";

function linked(text: string, dirty = false): Collection {
  return { ...newCollection("Checkout"), file: { path: PATH, syncedHash: textHash(text), dirty } };
}

describe("a collection linked to a file", () => {
  const original = serializeCollection(newCollection("Checkout")).text;
  const edited = original.replace("name: Checkout", "name: Checkout v2");

  it("does nothing when the file is as Studio left it", () => {
    expect(reconcile(linked(original).file!, original)).toBe("unchanged");
    expect(reconcile(linked(original, true).file!, original)).toBe("unchanged");
  });

  it("reloads a changed file when nothing in Studio is unsaved", () => {
    expect(reconcile(linked(original).file!, edited)).toBe("reload");
  });

  it("asks when both the file and the collection in Studio changed", () => {
    expect(reconcile(linked(original, true).file!, edited)).toBe("conflict");
  });

  it("notices a file that has gone", () => {
    expect(reconcile(linked(original).file!, null)).toBe("missing");
  });

  it("never overwrites a file that changed since it was read", () => {
    expect(canOverwrite(linked(original).file!, original)).toBe(true);
    expect(canOverwrite(linked(original).file!, null)).toBe(true);
    expect(canOverwrite(linked(original, true).file!, edited)).toBe(false);
  });

  it("taking the file keeps Studio's id and marks it saved", () => {
    const current = linked(original, true);
    const reloaded = fromDisk(current, PATH, edited);
    expect(reloaded.id).toBe(current.id);
    expect(reloaded.name).toBe("Checkout v2");
    expect(reloaded.file).toEqual({ path: PATH, syncedHash: textHash(edited), dirty: false });
  });

  it("keeping Studio's version makes it the one to save over the file", () => {
    const mine = keepMine(linked(original, true), edited);
    expect(mine.file?.dirty).toBe(true);
    expect(reconcile(mine.file!, edited)).toBe("unchanged");
    expect(canOverwrite(mine.file!, edited)).toBe(true);
  });

  it("gives a saved file the collection suffix", () => {
    expect(withCollectionSuffix("/r/checkout")).toBe("/r/checkout.spec0-collection.yaml");
    expect(withCollectionSuffix("/r/checkout.yaml")).toBe("/r/checkout.spec0-collection.yaml");
    expect(withCollectionSuffix("/r/checkout.spec0-collection.yml")).toBe("/r/checkout.spec0-collection.yml");
  });
});
