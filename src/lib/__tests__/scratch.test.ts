import { describe, expect, it } from "vitest";
import { buildScratchPlan, padFromHistory, scratchPath, sendsBody } from "../scratch";
import type { ScratchPad } from "../scratch";

const pad = (over: Partial<ScratchPad> = {}): ScratchPad => ({
  method: "GET",
  url: "https://api.example.com/things",
  headers: [],
  body: "",
  ...over,
});

describe("buildScratchPlan", () => {
  it("interpolates variables in the URL, header values and body", () => {
    const plan = buildScratchPlan(
      pad({
        method: "POST",
        url: "{{base}}/orders",
        headers: [{ key: "Authorization", value: "Bearer {{token}}" }],
        body: '{"region":"{{region}}"}',
      }),
      { base: "https://api.example.com", token: "sk_live", region: "eu" },
    );

    expect(plan.url).toBe("https://api.example.com/orders");
    expect(plan.headers.Authorization).toBe("Bearer sk_live");
    expect(plan.body).toEqual({ kind: "text", text: '{"region":"eu"}' });
  });

  it("rejects a URL that doesn't resolve to something sendable", () => {
    expect(() => buildScratchPlan(pad({ url: "  " }))).toThrow(/Enter a URL/);
    expect(() => buildScratchPlan(pad({ url: "api.example.com" }))).toThrow(/http/);
  });

  it("drops the body on methods that don't carry one", () => {
    expect(buildScratchPlan(pad({ method: "GET", body: '{"a":1}' })).body).toBeUndefined();
    expect(buildScratchPlan(pad({ method: "POST", body: '{"a":1}' })).body).toEqual({
      kind: "text",
      text: '{"a":1}',
    });
  });

  it("infers Content-Type from the body, but never overrides one that was set", () => {
    expect(buildScratchPlan(pad({ method: "POST", body: '{"a":1}' })).headers["Content-Type"]).toBe(
      "application/json",
    );
    expect(buildScratchPlan(pad({ method: "POST", body: "plain words" })).headers["Content-Type"]).toBe(
      "text/plain",
    );
    // A malformed JSON-looking body is not JSON. Saying it is would make the
    // server's rejection harder to read, not easier.
    expect(buildScratchPlan(pad({ method: "POST", body: "{oops" })).headers["Content-Type"]).toBe(
      "text/plain",
    );

    const explicit = buildScratchPlan(
      pad({ method: "POST", body: "a=1", headers: [{ key: "content-type", value: "text/csv" }] }),
    );
    expect(explicit.headers["content-type"]).toBe("text/csv");
    expect(explicit.headers["Content-Type"]).toBeUndefined();
  });

  it("skips header rows that were left blank", () => {
    const plan = buildScratchPlan(
      pad({
        headers: [
          { key: "", value: "orphan" },
          { key: "X-Trace", value: "" },
          { key: " X-Real ", value: "yes" },
        ],
      }),
    );
    expect(plan.headers).toEqual({ "X-Real": "yes", Accept: "*/*" });
  });
});

describe("sendsBody", () => {
  it("matches the spec-driven path: everything but GET and HEAD", () => {
    expect(sendsBody("get")).toBe(false);
    expect(sendsBody("HEAD")).toBe(false);
    expect(sendsBody("post")).toBe(true);
    expect(sendsBody("DELETE")).toBe(true);
  });
});

describe("scratchPath", () => {
  it("shows the path and query, so history rows stay readable", () => {
    expect(scratchPath("https://api.example.com/v1/orders?limit=10")).toBe("/v1/orders?limit=10");
  });

  it("falls back to the raw string when it isn't a URL", () => {
    expect(scratchPath("not a url")).toBe("not a url");
  });
});

describe("padFromHistory", () => {
  it("restores the request, minus the headers we re-derive on send", () => {
    const restored = padFromHistory({
      method: "POST",
      url: "https://api.example.com/things",
      headers: { "Content-Type": "application/json", Accept: "*/*", "X-Trace": "abc" },
      body: '{"a":1}',
    });

    expect(restored.method).toBe("POST");
    expect(restored.body).toBe('{"a":1}');
    expect(restored.headers).toEqual([{ key: "X-Trace", value: "abc" }]);
  });
});
