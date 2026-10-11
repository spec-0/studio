import { afterEach, describe, expect, it } from "vitest";
import { registerAgentApp, type AgentApp } from "../agentApp";
import { newCollection } from "../collection";
import { DEFAULT_CONNECTION } from "../connection";
import { answerCall } from "../mcpServer";
import { setKnownSecrets } from "../redact";

const SECRET = "tok_never_leaves_studio_123";

afterEach(() => {
  registerAgentApp(null);
  setKnownSecrets([]);
});

describe("answering calls", () => {
  it("redacts every result on its way out, whatever the tool put in it", async () => {
    setKnownSecrets([{ id: "e", name: "dev", variables: [{ name: "token", value: SECRET, secret: true }] }]);
    const collection = {
      ...newCollection("Leaky"),
      steps: [{ key: "a", pathParams: {}, queryParams: { q: SECRET }, headers: {}, body: `{"token":"${SECRET}"}` }],
    };
    const app = {
      entries: () => [],
      vars: () => ({ token: SECRET }),
      environment: () => null,
      connection: () => DEFAULT_CONNECTION,
      session: () => null,
      oauthToken: async () => "",
      historyChanged: () => undefined,
      localMocks: { running: () => ({}), start: async () => 0, stop: async () => undefined },
      collections: {
        list: () => [collection],
        add: () => undefined,
        change: () => null,
        run: async () => ({ error: "no" }),
        runLogs: () => [],
        saveTo: async () => [],
      },
    } as AgentApp;
    registerAgentApp(app);
    const result = await answerCall("get_collection", { collection: "Leaky" }, "Claude Code");
    const text = JSON.stringify(result);
    expect(text).not.toContain(SECRET);
    expect(text).toContain("{{token}}");
  });

  it("says Studio isn't ready before the window has registered", async () => {
    const result = await answerCall("list_collections", {}, "Claude Code");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/isn't ready/);
  });
});
