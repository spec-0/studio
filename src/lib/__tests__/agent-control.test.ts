import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityState,
  answerApproval,
  APPROVAL_TIMEOUT_MS,
  currentStopGeneration,
  gateMockStart,
  gateRequest,
  gateSave,
  noteAgent,
  pendingApprovals,
  recordActivity,
  resetAgentControl,
  sessionGrants,
  setAgentRules,
  stopAgents,
} from "../agentControl";
import { setKnownSecrets } from "../redact";

/** Let the approval appear, then answer the oldest one. */
async function answer(choice: "once" | "session" | "deny") {
  await Promise.resolve();
  const [first] = pendingApprovals();
  if (!first) throw new Error("nothing is waiting");
  answerApproval(first.id, choice);
}

beforeEach(() => {
  resetAgentControl();
  setKnownSecrets([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("approving requests", () => {
  it("asks for a new host and lets the request go on 'once', asking again next time", async () => {
    const first = gateRequest("Claude Code", { method: "GET", url: "http://localhost:8080/orders" });
    await Promise.resolve();
    const [approval] = pendingApprovals();
    expect(approval.title).toBe("Claude Code wants to send requests to localhost:8080, on this computer");
    expect(approval.lines).toEqual(["GET http://localhost:8080/orders"]);
    expect(approval.answers).toEqual(["deny", "once", "session"]);
    answerApproval(approval.id, "once");
    expect(await first).toBeNull();

    const second = gateRequest("Claude Code", { method: "GET", url: "http://localhost:8080/orders" });
    await answer("session");
    expect(await second).toBeNull();
    expect(sessionGrants().hosts).toEqual(["localhost:8080"]);

    // Allowed for the session: no question.
    expect(await gateRequest("Claude Code", { method: "DELETE", url: "http://localhost:8080/orders/1" })).toBeNull();
    expect(pendingApprovals()).toEqual([]);
  });

  it("refuses with a reason the agent can read when the developer says no", async () => {
    const pending = gateRequest("Cursor", { method: "GET", url: "https://api.example.com/x" });
    await answer("deny");
    expect(await pending).toBe("The user didn't allow sending GET requests to api.example.com:443 in Studio.");
  });

  it("asks separately for a DELETE to an allowed host outside this computer", async () => {
    const read = gateRequest("Codex", { method: "GET", url: "https://api.example.com/x" });
    await answer("session");
    expect(await read).toBeNull();
    const remove = gateRequest("Codex", { method: "DELETE", url: "https://api.example.com/x/1" });
    await Promise.resolve();
    expect(pendingApprovals()[0]).toMatchObject({ kind: "changing", title: "Codex wants to send a DELETE request to api.example.com:443" });
    answerApproval(pendingApprovals()[0].id, "once");
    expect(await remove).toBeNull();
  });

  it("gives up after the timeout, without sending", async () => {
    vi.useFakeTimers();
    const pending = gateRequest("Claude Code", { method: "GET", url: "http://localhost:1/" });
    await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS + 1);
    expect(await pending).toMatch(/no answer within 5 minutes/);
    expect(pendingApprovals()).toEqual([]);
  });

  it("refuses a blocked host without asking", async () => {
    setAgentRules({ blockedHosts: ["*.example.com"] });
    expect(await gateRequest("Claude Code", { method: "GET", url: "https://api.example.com/" })).toMatch(/blocked/);
    expect(pendingApprovals()).toEqual([]);
  });

  it("refuses over the cap, after approval", async () => {
    setAgentRules({ maxRequestsPerMinute: 2 });
    const first = gateRequest("Claude Code", { method: "GET", url: "http://localhost:8080/" });
    await answer("session");
    expect(await first).toBeNull();
    expect(await gateRequest("Claude Code", { method: "GET", url: "http://localhost:8080/" })).toBeNull();
    expect(await gateRequest("Claude Code", { method: "GET", url: "http://localhost:8080/" })).toMatch(/2 a minute/);
  });

  it("never shows a secret value in an approval", async () => {
    setKnownSecrets([{ id: "e", name: "dev", variables: [{ name: "apiKey", value: "sk_live_123", secret: true }] }]);
    const pending = gateRequest("Claude Code", { method: "GET", url: "http://localhost:8080/x?key=sk_live_123" });
    await Promise.resolve();
    expect(pendingApprovals()[0].lines[0]).toBe("GET http://localhost:8080/x?key={{apiKey}}");
    answerApproval(pendingApprovals()[0].id, "deny");
    await pending;
  });
});

describe("mocks and files", () => {
  it("asks before starting a local mock, and 'session' covers the rest", async () => {
    const first = gateMockStart("Claude Code", "Orders");
    await answer("session");
    expect(await first).toBeNull();
    expect(await gateMockStart("Claude Code", "Payments")).toBeNull();
    expect(sessionGrants().mocks).toBe(true);
  });

  it("asks every time before saving a file, with only once or no", async () => {
    const first = gateSave("Claude Code", "Checkout", "/repo/checkout.spec0-collection.yaml", true);
    await Promise.resolve();
    expect(pendingApprovals()[0].answers).toEqual(["deny", "once"]);
    expect(pendingApprovals()[0].lines).toContain("A file is already there. Saving replaces it.");
    answerApproval(pendingApprovals()[0].id, "once");
    expect(await first).toBeNull();
    const second = gateSave("Claude Code", "Checkout", "/repo/checkout.spec0-collection.yaml", false);
    await answer("deny");
    expect(await second).toMatch(/didn't allow saving/);
  });
});

describe("stopping", () => {
  it("refuses everything waiting, forgets what was allowed, and moves the generation on", async () => {
    const allowed = gateRequest("Claude Code", { method: "GET", url: "http://localhost:8080/" });
    await answer("session");
    await allowed;
    const generation = currentStopGeneration();
    const waiting = gateRequest("Claude Code", { method: "GET", url: "http://localhost:9999/" });
    await Promise.resolve();
    stopAgents();
    expect(await waiting).toMatch(/stopped agents/);
    expect(pendingApprovals()).toEqual([]);
    expect(sessionGrants()).toEqual({ hosts: [], changing: [], mocks: false });
    expect(currentStopGeneration()).toBe(generation + 1);
  });
});

describe("activity", () => {
  it("keeps who connected and what happened, redacted", () => {
    setKnownSecrets([{ id: "e", name: "dev", variables: [{ name: "token", value: "tok_secret_value", secret: true }] }]);
    noteAgent({ name: "claude-code", version: "2.1.0" });
    recordActivity({
      agent: "Claude Code",
      tool: "request",
      ok: true,
      summary: "GET http://localhost/x → 200",
      sent: { method: "GET", url: "http://localhost/x", headers: { Authorization: "Bearer tok_secret_value" } },
      received: { status: 200, body: "echo tok_secret_value" },
    });
    const { activity, agents } = activityState();
    expect(agents).toMatchObject([{ name: "Claude Code", version: "2.1.0" }]);
    expect(JSON.stringify(activity)).not.toContain("tok_secret_value");
    expect(activity[0].sent?.headers?.Authorization).toBe("Bearer {{token}}");
  });
});
