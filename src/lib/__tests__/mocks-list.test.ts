import { describe, expect, it } from "vitest";
import { describeMocks } from "../spec0";

const API = "https://api.example.com";

describe("describeMocks", () => {
  it("makes host-relative mock URLs absolute", () => {
    const [row] = describeMocks([{ apiName: "Orders", mockBaseUrl: "/mock/orders" }], API);
    expect(row.url).toBe("https://api.example.com/mock/orders");
  });

  it("keeps absolute URLs as they are", () => {
    const [row] = describeMocks([{ apiName: "Orders", mockBaseUrl: "https://m.example.com/o" }], API);
    expect(row.url).toBe("https://m.example.com/o");
  });

  it("sorts by API name and leaves out mocks with no URL", () => {
    const rows = describeMocks(
      [
        { apiName: "Payments", mockBaseUrl: "/mock/p" },
        { apiName: "Broken" },
        { apiName: "Orders", mockBaseUrl: "/mock/o" },
      ],
      API,
    );
    expect(rows.map((row) => row.apiName)).toEqual(["Orders", "Payments"]);
  });

  it("shows the mock's own name only when it differs from the API's", () => {
    const rows = describeMocks(
      [
        { apiName: "Orders", name: "Orders", mockBaseUrl: "/mock/o" },
        { apiName: "Payments", name: "Payments sandbox", mockBaseUrl: "/mock/p" },
      ],
      API,
    );
    expect(rows.map((row) => row.name)).toEqual([null, "Payments sandbox"]);
  });

  it("falls back to the mock's name, then a placeholder, for the API", () => {
    const rows = describeMocks(
      [
        { name: "Legacy", mockBaseUrl: "/mock/l" },
        { mockBaseUrl: "/mock/x" },
      ],
      API,
    );
    expect(rows.map((row) => row.apiName)).toEqual(["Legacy", "Unnamed API"]);
  });

  it("carries the reported spec version, or null", () => {
    const rows = describeMocks(
      [
        { apiName: "A", mockBaseUrl: "/a", specVersion: "1.2.0", mockServerId: "m1" },
        { apiName: "B", mockBaseUrl: "/b" },
      ],
      API,
    );
    expect(rows[0]).toMatchObject({ specVersion: "1.2.0", key: "m1" });
    expect(rows[1].specVersion).toBeNull();
  });
});
