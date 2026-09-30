import { describe, expect, it } from "vitest";
import {
  CollectionFormatError,
  describeExpected,
  expectedStatusOf,
  newCollection,
  normaliseExpectedStatus,
  parseCollection,
  serializeCollection,
  statusMatches,
  type Collection,
} from "../collection";
import { addOperationStep, relinkStep } from "../collectionLink";
import { verdictFor } from "../collectionRun";
import type { LibraryEntry } from "../library";
import { declaredResponse } from "../response";
import { SAMPLE_SPEC } from "../sample";
import { parseSpec } from "../spec";
import { validateResponse } from "../validate";

const spec = parseSpec(SAMPLE_SPEC, "sample");
const op = (id: string) => spec.operations.find((o) => o.operationId === id)!;
const entry: LibraryEntry = {
  id: "sample_1",
  title: "Orders API (sample)",
  version: "1",
  source: { kind: "sample", ref: "sample" },
  operations: 0,
  schemas: 0,
  addedAt: "",
  openedAt: "",
};

describe("which statuses a step expects", () => {
  it("reads a code or a class, in either case", () => {
    expect(normaliseExpectedStatus("404")).toBe("404");
    expect(normaliseExpectedStatus(" 4xx ")).toBe("4XX");
    expect(normaliseExpectedStatus("2XX")).toBe("2XX");
    for (const bad of ["", "44", "4040", "600", "XX", "4x", "abc"]) expect(normaliseExpectedStatus(bad)).toBeNull();
  });

  it("matches a code exactly and a class by its first digit", () => {
    expect(statusMatches("404", 404)).toBe(true);
    expect(statusMatches("404", 400)).toBe(false);
    expect(statusMatches("4XX", 409)).toBe(true);
    expect(statusMatches("4XX", 500)).toBe(false);
  });

  it("expects any 2xx when it says nothing", () => {
    expect(statusMatches(undefined, 200)).toBe(true);
    expect(statusMatches(undefined, 204)).toBe(true);
    expect(statusMatches(undefined, 302)).toBe(false);
    expect(statusMatches(undefined, 404)).toBe(false);
    expect(describeExpected(undefined)).toBe("any 2xx");
    expect(describeExpected("4XX")).toBe("any 4xx");
    expect(describeExpected("409")).toBe("409");
    expect(expectedStatusOf({})).toBeUndefined();
    expect(expectedStatusOf({ expect: { status: "2xx" } })).toBeUndefined();
    expect(expectedStatusOf({ expect: { status: "404" } })).toBe("404");
  });
});

describe("pass or fail with an expected status", () => {
  const checked = (status: number, body: unknown, expected?: string) => {
    const declared = declaredResponse(op("getOrder").responses, status);
    return verdictFor(status, validateResponse(spec.doc, declared?.schema, body), expected);
  };

  it("passes a 404 that matches the spec's 404 schema when 404 is expected", () => {
    expect(checked(404, { title: "Not found", status: 404 }, "404")).toEqual({ verdict: "pass" });
    expect(checked(404, { title: "Not found", status: 404 }, "4XX")).toEqual({ verdict: "pass" });
  });

  it("fails a 404 whose body doesn't match the spec's 404 schema", () => {
    const result = checked(404, { message: "nope" }, "404");
    expect(result.verdict).toBe("fail");
    expect(result.reason).toMatch(/doesn't match the spec/);
  });

  it("fails the wrong status, saying what was expected", () => {
    expect(checked(200, {}, "404")).toEqual({ verdict: "fail", reason: "Expected 404, but the server answered 200." });
    expect(checked(500, {}, "4XX")).toEqual({ verdict: "fail", reason: "Expected any 4xx, but the server answered 500." });
    // The default keeps today's wording.
    expect(checked(404, { title: "x", status: 404 })).toEqual({ verdict: "fail", reason: "The server answered 404." });
  });

  it("passes, not checked, when the spec declares nothing for the status", () => {
    const result = verdictFor(409, validateResponse(spec.doc, undefined, { error: "twice" }), "409");
    expect(result.verdict).toBe("pass");
    expect(result.reason).toMatch(/^Not checked/);
  });

  it("passes an unlinked request on its status alone", () => {
    expect(verdictFor(404, null, "404").verdict).toBe("pass");
    expect(verdictFor(200, null, "404").verdict).toBe("fail");
  });
});

describe("in the collection file", () => {
  function flow(): Collection {
    let collection = addOperationStep(newCollection("Failures"), entry, spec, op("getOrder"), { pathParams: { orderId: "nope" } });
    collection = addOperationStep(collection, entry, spec, op("listOrders"));
    return {
      ...collection,
      steps: collection.steps.map((s, i) => (i === 0 ? { ...s, expect: { status: "404" }, note: "Deleted orders are gone." } : s)),
    };
  }

  it("writes expect only when it isn't the default, and reads it back", () => {
    const { text } = serializeCollection(flow());
    expect(text).toContain('expect:\n      status: "404"');
    expect(text.match(/expect:/g)).toHaveLength(1);
    expect(text).toContain("note: Deleted orders are gone.");
    const again = parseCollection(text);
    expect(again.steps[0].expect).toEqual({ status: "404" });
    expect(again.steps[0].note).toBe("Deleted orders are gone.");
    expect(again.steps[1].expect).toBeUndefined();
    expect(serializeCollection(again).text).toBe(text);
  });

  it("drops an explicit 2XX, normalises case, and rejects a status that isn't one", () => {
    const base = "version: 1\nname: x\napis: {}\nsteps:\n  - key: a\n    method: GET\n    url: https://a.example.net/\n";
    expect(parseCollection(`${base}    expect: { status: 2XX }\n`).steps[0].expect).toBeUndefined();
    expect(parseCollection(`${base}    expect: { status: 4xx }\n`).steps[0].expect).toEqual({ status: "4XX" });
    expect(parseCollection(`${base}    expect: { status: 404 }\n`).steps[0].expect).toEqual({ status: "404" });
    expect(() => parseCollection(`${base}    expect: { status: teapot }\n`)).toThrow(CollectionFormatError);
  });

  it("survives linking a step to another operation", () => {
    const relinked = relinkStep(flow(), 0, entry, op("getCustomer"));
    expect(relinked.steps[0].expect).toEqual({ status: "404" });
    expect(relinked.steps[0].note).toBe("Deleted orders are gone.");
  });
});
