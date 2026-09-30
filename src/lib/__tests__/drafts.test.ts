import { afterEach, describe, expect, it } from "vitest";
import {
  authFits,
  authFromDraft,
  discardDraft,
  draftKey,
  EMPTY_DRAFTS,
  forgetApi,
  hasUnsent,
  parseDrafts,
  recordEdit,
  recordSent,
  redactDrafts,
  restoreDraft,
  setAuthDraft,
  unsentIn,
  type DraftFile,
} from "../drafts";
import { editorFingerprint, seedEditor, type EditorState } from "../editor";
import { setKnownSecrets } from "../redact";
import { SAMPLE_SPEC } from "../sample";
import { parseSpec } from "../spec";

const sample = parseSpec(SAMPLE_SPEC, "sample");
const createOrder = sample.operations.find((op) => op.operationId === "createOrder")!;
const getOrder = sample.operations.find((op) => op.operationId === "getOrder")!;
const seed = seedEditor(sample, createOrder, null, false);
const now = "2026-09-30T12:00:00.000Z";
const later = "2026-09-30T12:05:00.000Z";

const key = draftKey("file_orders", createOrder.id);
const edited: EditorState = { ...seed, body: '{"customerId":"cus_42"}' };

afterEach(() => setKnownSecrets([]));

describe("draftKey", () => {
  it("is one operation of one API", () => {
    expect(draftKey("file_orders", "POST /orders")).toBe("file_orders POST /orders");
    expect(draftKey("file_orders", "POST /orders")).not.toBe(draftKey("url_other", "POST /orders"));
    expect(draftKey("file_orders", "GET /orders")).not.toBe(draftKey("file_orders", "POST /orders"));
  });
});

describe("recordEdit", () => {
  it("keeps nothing for an operation left as the spec suggests", () => {
    expect(recordEdit(EMPTY_DRAFTS, key, seed, seed, now)).toBe(EMPTY_DRAFTS);
    // Key order doesn't count as a change.
    const reordered = { ...seed, pathParams: { ...seed.pathParams } };
    expect(recordEdit(EMPTY_DRAFTS, key, reordered, seed, now).operations).toEqual({});
  });

  it("keeps an edit as unsent changes, and restores it", () => {
    const file = recordEdit(EMPTY_DRAFTS, key, edited, seed, now);
    expect(hasUnsent(file, key)).toBe(true);
    expect(restoreDraft(file, key)).toEqual(edited);
    expect(unsentIn(file, "file_orders")).toEqual(new Set([createOrder.id]));
    // Other operations and other APIs are untouched.
    expect(restoreDraft(file, draftKey("file_orders", getOrder.id))).toBeNull();
    expect(unsentIn(file, "url_other").size).toBe(0);
  });

  it("drops the draft when the fields are put back as the spec had them", () => {
    const file = recordEdit(recordEdit(EMPTY_DRAFTS, key, edited, seed, now), key, seed, seed, later);
    expect(file.operations[key]).toBeUndefined();
    expect(hasUnsent(file, key)).toBe(false);
  });

  it("returns the same file when nothing changed, so nothing is redrawn or written", () => {
    const file = recordEdit(EMPTY_DRAFTS, key, edited, seed, now);
    expect(recordEdit(file, key, { ...edited }, seed, later)).toBe(file);
  });
});

describe("after a send", () => {
  const sent = recordSent(recordEdit(EMPTY_DRAFTS, key, edited, seed, now), key, edited, later);

  it("makes the sent values the starting point: no dot, and they reopen", () => {
    expect(hasUnsent(sent, key)).toBe(false);
    expect(restoreDraft(sent, key)).toEqual(edited);
    expect(sent.operations[key].sentAt).toBe(later);
    expect(unsentIn(sent, "file_orders").size).toBe(0);
  });

  it("counts edits since the send as unsent, and going back to what was sent clears it", () => {
    const again = recordEdit(sent, key, { ...edited, body: "{}" }, seed, later);
    expect(hasUnsent(again, key)).toBe(true);
    const back = recordEdit(again, key, edited, seed, later);
    expect(hasUnsent(back, key)).toBe(false);
    // Putting the spec's examples back is a change from what was sent.
    expect(hasUnsent(recordEdit(sent, key, seed, seed, later), key)).toBe(true);
  });

  it("keeps edits made while the request was out as unsent", () => {
    const typing = recordEdit(EMPTY_DRAFTS, key, { ...edited, body: "{ }" }, seed, now);
    const answered = recordSent(typing, key, edited, later);
    expect(hasUnsent(answered, key)).toBe(true);
    expect(restoreDraft(answered, key)?.body).toBe("{ }");
  });

  it("discard goes back to the spec: the draft and the sent values are forgotten", () => {
    const discarded = discardDraft(sent, key);
    expect(restoreDraft(discarded, key)).toBeNull();
    expect(discarded.operations[key]).toBeUndefined();
    expect(discardDraft(discarded, key)).toBe(discarded);
  });
});

describe("forgetApi", () => {
  it("drops one API's drafts and auth, and nothing else", () => {
    let file = recordEdit(EMPTY_DRAFTS, key, edited, seed, now);
    file = recordEdit(file, draftKey("url_other", createOrder.id), edited, seed, now);
    file = setAuthDraft(file, "file_orders", { schemeName: "__bearer", type: "http", httpScheme: "bearer", value: "{{token}}" });
    const next = forgetApi(file, "file_orders");
    expect(Object.keys(next.operations)).toEqual([draftKey("url_other", createOrder.id)]);
    expect(next.auth.file_orders).toBeUndefined();
  });
});

describe("on disk", () => {
  const withSecrets = (): DraftFile => {
    setKnownSecrets([
      { id: "env", name: "Staging", variables: [{ name: "token", value: "sk_live_abc123", secret: true }] },
    ]);
    const values: EditorState = {
      ...seed,
      queryParams: { key: "sk_live_abc123" },
      headerParams: { Authorization: "Bearer sk_live_abc123" },
      body: '{"secret":"sk_live_abc123"}',
      formFields: [{ key: "token", value: "sk_live_abc123" }],
      parts: [{ name: "token", value: "sk_live_abc123" }],
      custom: [{ key: "X-Token", value: "sk_live_abc123" }],
    };
    let file = recordEdit(EMPTY_DRAFTS, key, values, seed, now);
    file = recordSent(file, key, values, now);
    return file;
  };

  it("writes known secret values as their references, everywhere a draft holds values", () => {
    const written = JSON.stringify(redactDrafts(withSecrets()));
    expect(written).not.toContain("sk_live_abc123");
    expect(written).toContain("{{token}}");
  });

  it("never writes a literal auth value, but keeps a reference", () => {
    let file = setAuthDraft(EMPTY_DRAFTS, "file_orders", {
      schemeName: "__bearer",
      type: "http",
      httpScheme: "bearer",
      value: "typed-straight-in",
    });
    file = setAuthDraft(file, "url_other", { schemeName: "__bearer", type: "http", value: "{{token}}" });
    const written = redactDrafts(file);
    expect(JSON.stringify(written)).not.toContain("typed-straight-in");
    expect(written.auth.file_orders).toMatchObject({ schemeName: "__bearer", value: "" });
    expect(written.auth.url_other.value).toBe("{{token}}");
    // In memory, the typed value is still there for this session.
    expect(file.auth.file_orders.value).toBe("typed-straight-in");
  });

  it("turns a known secret typed as the auth value into its reference", () => {
    setKnownSecrets([
      { id: "env", name: "Staging", variables: [{ name: "token", value: "sk_live_abc123", secret: true }] },
    ]);
    const file = setAuthDraft(EMPTY_DRAFTS, "file_orders", { schemeName: "__bearer", value: "sk_live_abc123" });
    expect(redactDrafts(file).auth.file_orders.value).toBe("{{token}}");
  });

  it("reads back what it wrote", () => {
    const file = recordSent(recordEdit(EMPTY_DRAFTS, key, edited, seed, now), key, edited, later);
    const read = parseDrafts(JSON.parse(JSON.stringify(redactDrafts(file))));
    expect(read).toEqual(file);
    expect(editorFingerprint(restoreDraft(read, key)!)).toBe(editorFingerprint(edited));
  });

  it("ignores anything that doesn't look like drafts, rather than failing", () => {
    expect(parseDrafts(null)).toEqual(EMPTY_DRAFTS);
    expect(parseDrafts("nonsense")).toEqual(EMPTY_DRAFTS);
    expect(parseDrafts({ version: 2, operations: {} })).toEqual(EMPTY_DRAFTS);
    const read = parseDrafts({
      version: 1,
      operations: { [key]: { values: { body: 1 } }, nospace: { values: edited, changed: true } },
      auth: { a: { value: 3 } },
    });
    expect(read.operations).toEqual({});
    expect(read.auth).toEqual({});
  });
});

describe("auth", () => {
  it("never restores an OAuth value: the token comes from the cache at send time", () => {
    expect(authFromDraft({ schemeName: "oauth", type: "oauth2", value: "leftover" })?.value).toBe("");
    expect(authFromDraft({ schemeName: null, value: "" })).toEqual({ schemeName: null, value: "" });
  });

  it("only restores a declared scheme the spec still declares", () => {
    expect(authFits({ schemeName: "bearerAuth", value: "" }, ["bearerAuth"])).toBe(true);
    expect(authFits({ schemeName: "gone", value: "" }, ["bearerAuth"])).toBe(false);
    expect(authFits({ schemeName: "__header", value: "" }, [])).toBe(true);
    expect(authFits({ schemeName: null, value: "" }, [])).toBe(true);
  });
});
