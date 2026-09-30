/**
 * History as a read-only log.
 *
 * A recorded request must say what happened *then*: the check result stored at
 * the time, whether the spec has changed since, and (only when asked) what
 * the current spec makes of it. These cover the pieces that make that honest.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiChoices,
  attachApiIds,
  belongsTo,
  checkFields,
  copyDestination,
  draftFromEntry,
  filterHistory,
  fingerprint,
  loadHistory,
  MAX_STORED_FINDINGS,
  recheck,
  record,
  recordedCheck,
  specChange,
  type HistoryEntry,
} from "../history";
import { setKnownSecrets } from "../redact";
import { SCRATCH_OPERATION_ID, SCRATCH_TITLE } from "../scratch";
import { parseSpec } from "../spec";
import { declaredResponse, responseFromHistory } from "../response";
import { validateResponse, type ValidationResult } from "../validate";

const SPEC = `
openapi: 3.0.3
info: { title: Orders, version: 1.0.0 }
paths:
  /orders/{id}:
    get:
      responses:
        "2XX":
          description: ok
          content:
            application/json:
              schema:
                type: object
                required: [id]
                properties: { id: { type: string } }
        default:
          description: error
          content:
            application/json:
              schema: { type: object, properties: { message: { type: string } } }
`;

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: "req_1",
    at: "2026-09-01T10:00:00.000Z",
    method: "GET",
    path: "/orders/{id}",
    url: "https://api.example.com/v1/orders/ord_1?expand=items",
    status: 200,
    ms: 42,
    bytes: 20,
    specTitle: "Orders",
    operationId: "GET /orders/{id}",
    headers: { Accept: "application/json" },
    responseBody: '{"id":"ord_1","extra":true}',
    ...overrides,
  };
}

describe("the shared status lookup", () => {
  const responses = [{ status: "200" }, { status: "2XX" }, { status: "4xx" }, { status: "default" }];

  it("prefers the exact code", () => {
    expect(declaredResponse(responses, 200)?.status).toBe("200");
  });

  // Re-checking from history needs this step too, or a response the live check
  // matched against `2XX` reads back from history as "no schema".
  it("falls back to the range", () => {
    expect(declaredResponse(responses, 201)?.status).toBe("2XX");
  });

  it("matches a lowercase range", () => {
    expect(declaredResponse(responses, 404)?.status).toBe("4xx");
  });

  it("then to default", () => {
    expect(declaredResponse(responses, 500)?.status).toBe("default");
  });

  it("finds nothing when nothing is declared", () => {
    expect(declaredResponse([{ status: "200" }], 500)).toBeUndefined();
  });
});

describe("storing the check result at record time", () => {
  it("keeps the verdict, the findings, and which spec it ran against", () => {
    const result: ValidationResult = {
      status: "mismatch",
      findings: [{ kind: "extra_field", path: "$.extra", message: "Response contains `extra`." }],
    };
    expect(checkFields(result, { version: "1.0.0", fingerprint: "abc" })).toEqual({
      validation: "mismatch",
      findings: result.findings,
      specVersion: "1.0.0",
      specFingerprint: "abc",
    });
  });

  it("keeps the note when there was no verdict", () => {
    expect(checkFields({ status: "no_schema", findings: [], note: "Response body isn't JSON." }))
      .toMatchObject({ validation: "no_schema", checkNote: "Response body isn't JSON." });
  });

  it("caps how many findings and how much text is stored", () => {
    const many: ValidationResult = {
      status: "mismatch",
      findings: Array.from({ length: 100 }, (_, i) => ({
        kind: "other" as const,
        path: `$.f${i}`,
        message: "x".repeat(1000),
      })),
    };
    const stored = checkFields(many).findings!;
    expect(stored).toHaveLength(MAX_STORED_FINDINGS);
    expect(stored[0].message.length).toBeLessThanOrEqual(300);
  });

  it("reads the recorded result back", () => {
    const check = recordedCheck(
      entry({ validation: "mismatch", findings: [{ kind: "other", path: "$", message: "m" }] }),
    );
    expect(check).toEqual({
      status: "mismatch",
      findings: [{ kind: "other", path: "$", message: "m" }],
      note: undefined,
    });
  });
});

describe("older entries", () => {
  // Older entries have none of these fields. They must still load and show
  // what they do have.
  it("show the verdict alone, without pretending there were no findings", () => {
    const check = recordedCheck(entry({ validation: "mismatch" }));
    expect(check?.status).toBe("mismatch");
    expect(check?.findings).toBeUndefined();
  });

  it("have no check result at all when none was recorded", () => {
    expect(recordedCheck(entry())).toBeNull();
  });

  it("can't say whether the spec changed", () => {
    expect(specChange(entry(), { fingerprint: "abc", version: "1.0.0" })).toBe("unknown");
  });

  it("belong to their API by title", () => {
    expect(belongsTo(entry(), { id: "lib_1", title: "Orders" })).toBe(true);
    expect(belongsTo(entry(), { id: "lib_1", title: "Billing" })).toBe(false);
  });

  it("still render a response that predates response capture as none", () => {
    expect(responseFromHistory(entry({ responseBody: undefined }))).toBeNull();
  });
});

describe("telling whether the spec changed", () => {
  it("compares fingerprints when both are known", () => {
    const e = entry({ specFingerprint: fingerprint(SPEC) });
    expect(specChange(e, { fingerprint: fingerprint(SPEC) })).toBe("same");
    expect(specChange(e, { fingerprint: fingerprint(`${SPEC}\n# edit`) })).toBe("changed");
  });

  it("treats a different version as a change even without a fingerprint", () => {
    expect(specChange(entry({ specVersion: "1.0.0" }), { version: "2.0.0" })).toBe("changed");
  });

  it("doesn't claim the same version means the same document", () => {
    expect(specChange(entry({ specVersion: "1.0.0" }), { version: "1.0.0" })).toBe("unknown");
  });

  it("is unknown with no current spec", () => {
    expect(specChange(entry({ specFingerprint: "abc" }), null)).toBe("unknown");
  });

  it("fingerprints are stable and short", () => {
    expect(fingerprint(SPEC)).toBe(fingerprint(SPEC));
    expect(fingerprint(SPEC).length).toBeLessThan(16);
  });
});

describe("re-checking against the current spec", () => {
  const spec = parseSpec(SPEC, "orders.yaml");

  it("uses the same range fallback a live send does", () => {
    const result = recheck(entry(), spec)!;
    expect(result.status).toBe("mismatch");
    expect(result.findings.map((f) => f.path)).toContain("$.extra");
  });

  it("agrees with a live check of the same body", () => {
    const op = spec.operations[0];
    const live = validateResponse(
      spec.doc,
      declaredResponse(op.responses, 200)?.schema,
      JSON.parse(entry().responseBody!),
    );
    expect(recheck(entry(), spec)).toEqual(live);
  });

  it("returns null when the operation is gone", () => {
    expect(recheck(entry({ operationId: "DELETE /orders/{id}" }), spec)).toBeNull();
  });

  it("returns null for a scratch request", () => {
    expect(recheck(entry({ operationId: SCRATCH_OPERATION_ID }), spec)).toBeNull();
  });
});

describe("copying to a new request", () => {
  const spec = parseSpec(SPEC, "orders.yaml");

  it("opens the operation when it still exists", () => {
    expect(copyDestination(entry(), spec)).toEqual({ kind: "operation" });
  });

  it("offers the scratch pad, with a reason, when the operation is gone", () => {
    const dest = copyDestination(entry({ operationId: "DELETE /orders/{id}" }), spec);
    expect(dest.kind).toBe("scratch");
    expect(dest.kind === "scratch" && dest.reason).toContain("no longer in this spec");
  });

  it("sends scratch requests back to the scratch pad", () => {
    expect(copyDestination(entry({ operationId: SCRATCH_OPERATION_ID }), spec)).toEqual({
      kind: "scratch",
    });
  });

  it("recovers the values and keeps the server's base path", () => {
    const draft = draftFromEntry(entry(), "/orders/{id}");
    expect(draft.server).toBe("https://api.example.com/v1");
    expect(draft.pathParams).toEqual({ id: "ord_1" });
    expect(draft.queryParams).toEqual({ expand: "items" });
  });
});

describe("one list, with filters", () => {
  const list: HistoryEntry[] = [
    entry({ id: "a", apiId: "lib_orders", status: 200, validation: "mismatch", mock: true }),
    entry({ id: "b", apiId: "lib_orders", status: 404, validation: "ok" }),
    entry({ id: "c", specTitle: "Billing", operationId: "GET /invoices", status: 503 }),
    entry({ id: "d", specTitle: SCRATCH_TITLE, operationId: SCRATCH_OPERATION_ID, status: 301 }),
  ];
  const ids = (entries: HistoryEntry[]) => entries.map((e) => e.id);

  it("lists each API once, with scratch last", () => {
    expect(apiChoices(list).map((c) => [c.key, c.count])).toEqual([
      ["id:lib_orders", 2],
      ["title:Billing", 1],
      [SCRATCH_OPERATION_ID, 1],
    ]);
  });

  it("filters by API", () => {
    expect(ids(filterHistory(list, { api: "id:lib_orders" }))).toEqual(["a", "b"]);
    expect(ids(filterHistory(list, { api: SCRATCH_OPERATION_ID }))).toEqual(["d"]);
  });

  it("filters by status class", () => {
    expect(ids(filterHistory(list, { status: "2xx" }))).toEqual(["a"]);
    expect(ids(filterHistory(list, { status: "3xx" }))).toEqual(["d"]);
    expect(ids(filterHistory(list, { status: "errors" }))).toEqual(["b", "c"]);
  });

  it("filters to drift only", () => {
    expect(ids(filterHistory(list, { driftOnly: true }))).toEqual(["a"]);
  });

  it("filters mock or real", () => {
    expect(ids(filterHistory(list, { target: "mock" }))).toEqual(["a"]);
    expect(ids(filterHistory(list, { target: "real" }))).toEqual(["b", "c", "d"]);
  });

  it("combines filters with search", () => {
    expect(ids(filterHistory(list, { api: "id:lib_orders", query: "404" }))).toEqual(["b"]);
  });

  it("keeps a new entry with its library id out of another API with the same title", () => {
    expect(belongsTo(list[0], { id: "lib_other", title: "Orders" })).toBe(false);
  });
});

describe("matching older entries to their API", () => {
  it("adopts the library id when exactly one API has the title", () => {
    const [e] = attachApiIds([entry()], [{ id: "lib_orders", title: "Orders" }]);
    expect(e.apiId).toBe("lib_orders");
  });

  it("leaves an ambiguous title alone rather than guess", () => {
    const [e] = attachApiIds(
      [entry()],
      [
        { id: "lib_a", title: "Orders" },
        { id: "lib_b", title: "Orders" },
      ],
    );
    expect(e.apiId).toBeUndefined();
  });

  it("never changes an entry that already has an id, or a scratch entry", () => {
    const list = [
      entry({ apiId: "lib_x" }),
      entry({ specTitle: "Scratch", operationId: SCRATCH_OPERATION_ID }),
    ];
    expect(attachApiIds(list, [{ id: "lib_orders", title: "Orders" }, { id: "s", title: "Scratch" }]))
      .toBe(list);
  });
});

describe("recording", () => {
  let store: Record<string, string>;
  beforeEach(() => {
    store = {};
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => store[key] ?? null,
        setItem: (key: string, value: string) => {
          store[key] = value;
        },
        removeItem: (key: string) => {
          delete store[key];
        },
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setKnownSecrets([]);
  });

  const { id: _id, at: _at, ...raw } = entry();

  it("stores the new fields, and entries without them still load", async () => {
    store["studio:history.json"] = JSON.stringify([
      { ...entry({ id: "old" }), at: new Date().toISOString() },
    ]);
    await record({
      ...raw,
      apiId: "lib_orders",
      environment: "Staging",
      ...checkFields(
        { status: "mismatch", findings: [{ kind: "extra_field", path: "$.extra", message: "m" }] },
        { version: "1.0.0", fingerprint: "fp" },
      ),
    });
    const loaded = await loadHistory();
    expect(loaded).toHaveLength(2);
    expect(loaded[0]).toMatchObject({
      apiId: "lib_orders",
      environment: "Staging",
      findings: [{ path: "$.extra" }],
      specFingerprint: "fp",
    });
    expect(loaded[1].id).toBe("old");
  });

  it("gives entries recorded together distinct ids", async () => {
    await record(raw);
    await record(raw);
    const [a, b] = await loadHistory();
    expect(a.id).not.toBe(b.id);
  });

  it("redacts secrets in the stored check result too", async () => {
    setKnownSecrets([
      { id: "e", name: "Staging", variables: [{ name: "token", value: "sk_live_42", secret: true }] },
    ]);
    await record({
      ...raw,
      ...checkFields({
        status: "mismatch",
        findings: [
          { kind: "type_mismatch", path: "$.sk_live_42", message: "Got sk_live_42 where a number goes." },
        ],
        note: "sk_live_42",
      }),
    });
    const text = Object.values(store).join("\n");
    expect(text).not.toContain("sk_live_42");
    expect(text).toContain("{{token}}");
  });
});
