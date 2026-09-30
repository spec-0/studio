import { describe, expect, it } from "vitest";
import {
  EMPTY_PANE,
  KEPT_LIMIT,
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
  { type: "start", sendId: 1, sentAt: "2026-09-30T14:03:12.000Z", fingerprint: "sent-values" },
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

  it("takes the answer off screen, curl included, when another operation is picked", () => {
    const after = paneReducer(answered, { type: "show", owner: getPet });
    expect(after.owner).toBe(getPet);
    expect(after.result).toBeNull();
    expect(after.validation).toBeNull();
    expect(after.curl).toBeNull();
    expect(after.restored).toBe(false);
  });

  it("brings the answer back when you return to an operation, marked as restored with when it was sent", () => {
    const back = run(
      [
        { type: "show", owner: getPet },
        { type: "show", owner: listPets },
      ],
      answered,
    );
    expect(back.result).toBe(response);
    expect(back.validation).toBe(matches);
    expect(back.curl).toContain("findByStatus");
    expect(back.restored).toBe(true);
    expect(back.sentAt).toBe("2026-09-30T14:03:12.000Z");
    // What the editor held when it was sent, so the view can tell if it changed since.
    expect(back.fingerprint).toBe("sent-values");
    // Nothing else is held for the request on screen.
    expect(back.kept[listPets]).toBeUndefined();
  });

  it("marks a new send's answer as new, not restored", () => {
    const back = run(
      [
        { type: "show", owner: getPet },
        { type: "show", owner: listPets },
        { type: "start", sendId: 7, sentAt: "2026-09-30T15:00:00.000Z" },
        { type: "response", sendId: 7, result: response, validation: matches },
        { type: "done", sendId: 7 },
      ],
      answered,
    );
    expect(back.restored).toBe(false);
    expect(back.sentAt).toBe("2026-09-30T15:00:00.000Z");
  });

  it("keeps each API's answers apart, even for operations with the same id", () => {
    const other = paneOwner("api", "other-api", "findPetsByStatus")!;
    const there = paneReducer(answered, { type: "show", owner: other });
    expect(there.result).toBeNull();
    expect(paneReducer(there, { type: "show", owner: listPets }).result).toBe(response);
  });

  it("moves between an operation and the scratch pad, each with its own answer", () => {
    const scratch = paneReducer(answered, { type: "show", owner: "scratch" });
    expect(scratch.result).toBeNull();
    const scratchAnswered = run(
      [
        { type: "start", sendId: 2 },
        { type: "response", sendId: 2, result: { ...response, status: 201 }, validation: null },
        { type: "done", sendId: 2 },
      ],
      scratch,
    );
    expect(scratchAnswered.result?.status).toBe(201);
    const back = paneReducer(scratchAnswered, { type: "show", owner: listPets });
    expect(back.result).toBe(response);
    expect(back.restored).toBe(true);
  });

  it("doesn't keep a send that was still in flight: it goes to History only", () => {
    const pane = run([
      { type: "show", owner: listPets },
      { type: "start", sendId: 1 },
      { type: "show", owner: getPet },
      { type: "show", owner: listPets },
    ]);
    expect(pane.result).toBeNull();
    expect(pane.restored).toBe(false);
  });

  it("drops one request's kept answer when asked, without touching the one on screen", () => {
    const elsewhere = paneReducer(answered, { type: "show", owner: getPet });
    const dropped = paneReducer(elsewhere, { type: "clear", owner: listPets, curl: true });
    expect(dropped.kept[listPets]).toBeUndefined();
    expect(paneReducer(dropped, { type: "show", owner: listPets }).result).toBeNull();
    // Naming the request on screen clears the pane, as a plain clear does.
    expect(paneReducer(answered, { type: "clear", owner: listPets, curl: true })).toMatchObject({
      result: null,
      curl: null,
    });
  });

  it(`keeps at most ${KEPT_LIMIT} answers off screen, dropping the oldest`, () => {
    let pane = EMPTY_PANE;
    for (let index = 0; index <= KEPT_LIMIT + 1; index += 1) {
      pane = run(
        [
          { type: "show", owner: `api:a:op${index}` },
          { type: "start", sendId: index + 1 },
          { type: "response", sendId: index + 1, result: response, validation: null },
          { type: "done", sendId: index + 1 },
        ],
        pane,
      );
    }
    pane = paneReducer(pane, { type: "show", owner: "api:a:elsewhere" });
    expect(Object.keys(pane.kept)).toHaveLength(KEPT_LIMIT);
    expect(pane.kept["api:a:op0"]).toBeUndefined();
    expect(pane.kept["api:a:op1"]).toBeUndefined();
    expect(pane.kept[`api:a:op${KEPT_LIMIT + 1}`]).toBeDefined();
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
    // Nor is it kept for when you go back.
    expect(paneReducer(late, { type: "show", owner: listPets }).result).toBeNull();
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

  it("shows the new owner's kept answer, as restored, before the pane has caught up", () => {
    const elsewhere = paneReducer(answered, { type: "show", owner: getPet });
    const shown = visiblePane(elsewhere, listPets);
    expect(shown.result).toBe(response);
    expect(shown.restored).toBe(true);
  });

  it("shows the pane for its own owner, and on screens without a pane", () => {
    expect(visiblePane(answered, listPets)).toBe(answered);
    expect(visiblePane(answered, null)).toBe(answered);
  });
});
