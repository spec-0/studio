import { afterEach, describe, expect, it } from "vitest";
import { redact, redactHeaders, setKnownSecrets } from "../redact";
import { redactEntry } from "../history";
import { summarise, toMarkdown } from "../runner";
import { redactedFile } from "../env";
import type { Environment } from "../env";
import type { RunResult } from "../runner";

const environments: Environment[] = [
  {
    id: "env_a",
    name: "Staging",
    variables: [
      { name: "baseUrl", value: "https://api.example.com", secret: false },
      { name: "token", value: "sk_test_abc123", secret: true },
      { name: "password", value: "p@ss word&1", secret: true },
    ],
  },
  { id: "env_b", name: "Prod", variables: [{ name: "apiKey", value: "live_key_999", secret: true }] },
];

afterEach(() => setKnownSecrets([]));

describe("redaction", () => {
  it("replaces a secret value with its reference", () => {
    setKnownSecrets(environments);
    expect(redact("Bearer sk_test_abc123")).toBe("Bearer {{token}}");
    // Values from every environment, not only the active one.
    expect(redact("key=live_key_999")).toBe("key={{apiKey}}");
  });

  it("catches a value as it appears URL-encoded", () => {
    setKnownSecrets(environments);
    expect(redact("https://x.test/?pw=p%40ss%20word%261")).toBe("https://x.test/?pw={{password}}");
    expect(redact("pw=p%40ss+word%261")).toBe("pw={{password}}");
  });

  it("decodes a Basic credential to find the secret inside", () => {
    setKnownSecrets(environments);
    const headers = redactHeaders({ Authorization: `Basic ${btoa("alice:sk_test_abc123")}` });
    expect(headers.Authorization).toBe("Basic alice:{{token}}");
    expect(JSON.stringify(headers)).not.toContain(btoa("alice:sk_test_abc123"));
  });

  it("leaves non-secret values and text alone", () => {
    setKnownSecrets(environments);
    expect(redact("https://api.example.com/orders")).toBe("https://api.example.com/orders");
  });

  it("does nothing when there are no secrets", () => {
    expect(redact("sk_test_abc123")).toBe("sk_test_abc123");
  });
});

describe("what Studio writes down never holds a secret value", () => {
  const values = ["sk_test_abc123", "live_key_999", "p@ss word&1", encodeURIComponent("p@ss word&1")];
  const leaks = (text: string) => values.filter((value) => text.includes(value));

  it("history entries", () => {
    setKnownSecrets(environments);
    const entry = redactEntry({
      method: "GET",
      path: "/orders",
      url: "https://api.example.com/orders?api_key=live_key_999",
      status: 200,
      ms: 12,
      bytes: 20,
      specTitle: "Orders",
      operationId: "GET /orders",
      headers: { Authorization: "Bearer sk_test_abc123" },
      body: '{"password":"p@ss word&1"}',
      responseHeaders: { "x-echo": "sk_test_abc123" },
      responseBody: '{"you_sent":"sk_test_abc123"}',
    });
    expect(leaks(JSON.stringify(entry))).toEqual([]);
    expect(entry.headers.Authorization).toBe("Bearer {{token}}");
  });

  it("the exported run report, including error messages", () => {
    setKnownSecrets(environments);
    const results = [
      {
        operation: { method: "GET", path: "/orders" },
        verdict: "error",
        error: "error sending request for url (https://api.example.com/orders?api_key=live_key_999)",
      },
    ] as unknown as RunResult[];
    expect(summarise(results).errored).toBe(1);
    const markdown = toMarkdown(results, { title: "Orders", target: "https://api.example.com", scope: "all" });
    expect(leaks(markdown)).toEqual([]);
    expect(markdown).toContain("api_key={{apiKey}}");
  });

  it("the committable environments file", () => {
    const file = redactedFile({ environments, activeId: "env_a" });
    expect(leaks(JSON.stringify(file))).toEqual([]);
    // It still records that the secret exists.
    expect(file.environments[0].variables[1]).toEqual({ name: "token", value: "", secret: true });
    expect(file.environments[0].variables[0].value).toBe("https://api.example.com");
  });
});
