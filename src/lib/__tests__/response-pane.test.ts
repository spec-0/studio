import { describe, expect, it } from "vitest";
import {
  EMPTY_PANE,
  paneOwner,
  paneReducer,
  visiblePane,
  type PaneAction,
  type ResponsePane,
} from "../responsePane";
import type { ResponseResult } from "../request";
import type { ValidationResult } from "../validate";

const response: ResponseResult = {
  status: 200,
  statusText: "OK",
  headers: {},
  bodyText: "[]",
  json: [],
  ms: 12,
  bytes: 2,
};
const matches: ValidationResult = { status: "ok", findings: [] };

const run = (actions: PaneAction[], from: ResponsePane = EMPTY_PANE) => actions.reduce(paneReducer, from);

const listPets = paneOwner("api", "petstore", "findPetsByStatus")!;
const getPet = paneOwner("api", "petstore", "getPetById")!;

/** A pane showing a finished send to `findPetsByStatus`. */
const answered = run([
  { type: "show", owner: listPets },
  { type: "start", sendId: 1 },
  { type: "curl", sendId: 1, curl: "curl https://petstore.example/pet/findByStatus" },
  { type: "response", sendId: 1, result: response, validation: matches },
  { type: "done", sendId: 1 },
]);

describe("paneOwner", () => {
  it("is one operation of one API, or the scratch pad", () => {
    expect(paneOwner("api", "petstore", "getPetById")).toBe("api:petstore:getPetById");
    expect(paneOwner("api", "other", "getPetById")).not.toBe(paneOwner("api", "petstore", "getPetById"));
    expect(paneOwner("scratch", "petstore", "getPetById")).toBe("scratch");
  });

  it("is null on screens without a response pane, or with no operation picked", () => {
    for (const route of ["library", "history", "mocks", "mcp", "settings"] as const) {
      expect(paneOwner(route, "petstore", "getPetById")).toBeNull();
    }
    expect(paneOwner("api", "petstore", undefined)).toBeNull();
    expect(paneOwner("api", undefined, "getPetById")).toBeNull();
  });
});

describe("paneReducer", () => {
  it("shows a finished send", () => {
    expect(answered.result).toBe(response);
    expect(answered.validation).toBe(matches);
    expect(answered.curl).toContain("findByStatus");
    expect(answered.sending).toBe(false);
  });

  it("empties the pane, curl included, when another operation is picked", () => {
    const after = paneReducer(answered, { type: "show", owner: getPet });
    expect(after).toEqual({ ...EMPTY_PANE, owner: getPet });
  });

  it("doesn't bring the last response back when you return to an operation", () => {
    const back = run(
      [
        { type: "show", owner: getPet },
        { type: "show", owner: listPets },
      ],
      answered,
    );
    expect(back.result).toBeNull();
    expect(back.validation).toBeNull();
  });

  it("empties the pane when switching API, even to an operation with the same id", () => {
    const other = paneOwner("api", "other-api", "findPetsByStatus");
    expect(paneReducer(answered, { type: "show", owner: other }).result).toBeNull();
  });

  it("empties the pane moving between an operation and the scratch pad, both ways", () => {
    const scratch = paneReducer(answered, { type: "show", owner: "scratch" });
    expect(scratch.result).toBeNull();
    const scratchAnswered = run(
      [
        { type: "start", sendId: 2 },
        { type: "response", sendId: 2, result: response, validation: null },
        { type: "done", sendId: 2 },
      ],
      scratch,
    );
    expect(scratchAnswered.result).toBe(response);
    expect(paneReducer(scratchAnswered, { type: "show", owner: listPets }).result).toBeNull();
  });

  it("keeps the response through screens without a pane, like Settings", () => {
    expect(paneReducer(answered, { type: "show", owner: null })).toBe(answered);
    expect(paneReducer(answered, { type: "show", owner: listPets })).toBe(answered);
  });

  it("drops a response that lands after another operation was picked", () => {
    const late = run([
      { type: "show", owner: listPets },
      { type: "start", sendId: 1 },
      { type: "curl", sendId: 1, curl: "curl …" },
      { type: "show", owner: getPet },
      { type: "response", sendId: 1, result: response, validation: matches },
      { type: "fail", sendId: 1, error: "timed out" },
      { type: "done", sendId: 1 },
    ]);
    expect(late).toEqual({ ...EMPTY_PANE, owner: getPet });
  });

  it("drops a response that lands after you left and came back", () => {
    const late = run([
      { type: "show", owner: listPets },
      { type: "start", sendId: 1 },
      { type: "show", owner: getPet },
      { type: "show", owner: listPets },
      { type: "response", sendId: 1, result: response, validation: matches },
    ]);
    expect(late.result).toBeNull();
  });

  it("drops an older send's response once a newer one has started", () => {
    const pane = run([
      { type: "show", owner: listPets },
      { type: "start", sendId: 1 },
      { type: "start", sendId: 2 },
      { type: "response", sendId: 1, result: { ...response, status: 500 }, validation: null },
      { type: "done", sendId: 1 },
    ]);
    expect(pane.result).toBeNull();
    expect(pane.sending).toBe(true);
  });

  it("stops showing a send as in flight once the pane is emptied", () => {
    const pane = run([
      { type: "show", owner: listPets },
      { type: "start", sendId: 1 },
      { type: "show", owner: getPet },
    ]);
    expect(pane.sending).toBe(false);
  });

  it("keeps the curl line on a plain clear, and drops it when asked", () => {
    expect(paneReducer(answered, { type: "clear" }).curl).toBe(answered.curl);
    expect(paneReducer(answered, { type: "clear" }).result).toBeNull();
    expect(paneReducer(answered, { type: "clear", curl: true }).curl).toBeNull();
  });
});

describe("visiblePane", () => {
  it("hides the previous owner's response before the pane has caught up", () => {
    expect(visiblePane(answered, getPet).result).toBeNull();
    expect(visiblePane(answered, getPet).curl).toBeNull();
  });

  it("shows the pane for its own owner, and on screens without a pane", () => {
    expect(visiblePane(answered, listPets)).toBe(answered);
    expect(visiblePane(answered, null)).toBe(answered);
  });
});
