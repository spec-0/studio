/**
 * Reading a recorded request back.
 *
 * History stores the URL that went out, not the values that built it. Copying
 * an entry restored headers and body but left every path and query field empty, so
 * clicking `GET /accounts/{accountId}` showed a blank `accountId` beside the
 * 200 it had returned — which reads as the app losing the record.
 */

import { describe, expect, it } from "vitest";
import { paramsFromEntry } from "../history";

const at = (url: string) => ({ url });

describe("recovering the values a request was sent with", () => {
  it("reads a path parameter back out", () => {
    const { pathParams } = paramsFromEntry(
      at("https://api.example.com/accounts/acc_123"),
      "/accounts/{accountId}",
    );
    expect(pathParams).toEqual({ accountId: "acc_123" });
  });

  it("reads query parameters back out", () => {
    const { queryParams } = paramsFromEntry(
      at("https://api.example.com/accounts?limit=25&cursor=abc"),
      "/accounts",
    );
    expect(queryParams).toEqual({ limit: "25", cursor: "abc" });
  });

  it("handles several path parameters", () => {
    const { pathParams } = paramsFromEntry(
      at("https://api.example.com/orgs/o_1/members/m_2"),
      "/orgs/{orgId}/members/{memberId}",
    );
    expect(pathParams).toEqual({ orgId: "o_1", memberId: "m_2" });
  });

  // A server URL can carry its own base path, so the template is the tail of
  // the recorded path rather than the whole of it.
  it("lines up when the server has a base path", () => {
    const { pathParams } = paramsFromEntry(
      at("https://api.example.com/v1/accounts/acc_9"),
      "/accounts/{accountId}",
    );
    expect(pathParams).toEqual({ accountId: "acc_9" });
  });

  it("decodes an encoded value", () => {
    const { pathParams } = paramsFromEntry(
      at("https://api.example.com/files/a%2Fb%20c"),
      "/files/{key}",
    );
    expect(pathParams).toEqual({ key: "a/b c" });
  });

  // Guessing is worse than leaving it empty: a wrong value quietly sitting in a
  // field is a request the developer never chose to build.
  it("fills nothing when the template doesn't match the URL", () => {
    const { pathParams } = paramsFromEntry(
      at("https://api.example.com/invoices/inv_1"),
      "/accounts/{accountId}",
    );
    expect(pathParams).toEqual({});
  });

  it("still returns query parameters when the path doesn't line up", () => {
    const { pathParams, queryParams } = paramsFromEntry(
      at("https://api.example.com/invoices/inv_1?limit=5"),
      "/accounts/{accountId}",
    );
    expect(pathParams).toEqual({});
    expect(queryParams).toEqual({ limit: "5" });
  });

  it("returns nothing for a URL it can't parse, rather than throwing", () => {
    expect(paramsFromEntry(at("not a url"), "/accounts/{accountId}")).toEqual({
      pathParams: {},
      queryParams: {},
    });
  });

  it("handles a path with no parameters at all", () => {
    const { pathParams, queryParams } = paramsFromEntry(
      at("https://api.example.com/accounts"),
      "/accounts",
    );
    expect(pathParams).toEqual({});
    expect(queryParams).toEqual({});
  });
});
