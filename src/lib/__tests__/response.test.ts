import { describe, expect, it } from "vitest";
import {
  declaredResponse,
  describeSendError,
  responseFromHistory,
  storedResponseBody,
  suggestedFileName,
} from "../response";
import type { HistoryEntry } from "../history";
import type { ResponseResult } from "../request";

describe("declaredResponse", () => {
  const responses = [
    { status: "200" },
    { status: "4XX" },
    { status: "default" },
  ];

  it("prefers an exact status, then the range, then default", () => {
    expect(declaredResponse(responses, 200)?.status).toBe("200");
    expect(declaredResponse(responses, 404)?.status).toBe("4XX");
    expect(declaredResponse(responses, 500)?.status).toBe("default");
  });

  it("is undefined when nothing matches", () => {
    expect(declaredResponse([{ status: "200" }], 500)).toBeUndefined();
  });
});

const response = (extra: Partial<ResponseResult> = {}): ResponseResult => ({
  status: 200,
  statusText: "OK",
  headers: {},
  bodyText: '{"a":1}',
  ms: 12,
  bytes: 7,
  ...extra,
});

describe("storedResponseBody", () => {
  it("keeps a text body", () => {
    expect(storedResponseBody(response())).toBe('{"a":1}');
  });

  it("stores a note instead of a binary body", () => {
    const binary = { contentType: "application/pdf", byteLength: 40, path: "/tmp/x", previewBase64: null };
    expect(storedResponseBody(response({ bodyText: "", binary }))).toBe(
      "(application/pdf · 40 bytes, not stored)",
    );
    expect(storedResponseBody(response({ bodyText: "", binary: { ...binary, contentType: "" } }))).toBe(
      "(binary · 40 bytes, not stored)",
    );
  });
});

describe("responseFromHistory", () => {
  const entry = (extra: Partial<HistoryEntry> = {}): HistoryEntry => ({
    id: "h1",
    at: "2026-01-01T00:00:00Z",
    method: "GET",
    path: "/pets",
    url: "https://api.example.com/pets",
    status: 200,
    ms: 30,
    bytes: 9,
    specTitle: "Pets",
    operationId: "GET /pets",
    headers: {},
    ...extra,
  });

  it("is null for an entry recorded before responses were stored", () => {
    expect(responseFromHistory(entry())).toBeNull();
  });

  it("parses a JSON body and fills defaults", () => {
    expect(responseFromHistory(entry({ responseBody: '{"ok":true}' }))).toEqual({
      status: 200,
      statusText: "",
      headers: {},
      bodyText: '{"ok":true}',
      json: { ok: true },
      ms: 30,
      bytes: 9,
    });
  });

  it("keeps a body that isn't JSON as text", () => {
    const shown = responseFromHistory(entry({ responseBody: "<html>", statusText: "OK" }));
    expect(shown?.json).toBeUndefined();
    expect(shown?.bodyText).toBe("<html>");
    expect(shown?.statusText).toBe("OK");
  });

  it("treats an empty stored body as no JSON", () => {
    expect(responseFromHistory(entry({ responseBody: "" }))?.json).toBeUndefined();
  });
});

describe("describeSendError", () => {
  it("adds a CORS note only in the browser preview", () => {
    expect(describeSendError(new Error("boom"), true)).toBe("boom");
    expect(describeSendError(new Error("boom"), false)).toMatch(/^boom\n\n\(Browser preview/);
  });

  it("stringifies a non-Error", () => {
    expect(describeSendError("plain", false)).toBe("plain");
  });
});

describe("suggestedFileName", () => {
  it("uses the server's file name when it gives one", () => {
    expect(suggestedFileName('attachment; filename="report.pdf"', "application/pdf")).toBe("report.pdf");
    expect(suggestedFileName("attachment; filename*=UTF-8''r%C3%A9.pdf", "")).toBe("r%C3%A9.pdf");
  });

  it("falls back to response plus an extension", () => {
    expect(suggestedFileName("", "image/png")).toBe("response.png");
    expect(suggestedFileName("inline", "text/x-unknown")).toBe("response");
  });
});
