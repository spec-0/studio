import { errorText, isAuthRequired, openChat, type McpLink } from "./acpClient";
import { startAgent, type AgentId, type AgentProcess } from "./acpProcess";
import { currentVersion } from "./appUpdates";
import { logAgentSession } from "./appConsole";
import { endpoint, loadMcpPrefs, mcpStatus } from "./mcpServer";
import { redact } from "./redact";

const MCP_TEXT: Record<McpLink, string> = {
  connected: "It was given Studio's MCP server.",
  "server-off": "Studio's MCP server is off, so a chat won't have Studio's tools until you start it.",
  unsupported: "It can't connect to an MCP server over HTTP, so it won't have Studio's tools.",
};

/**
 * Start the agent, open a session, and stop it again, without sending it a
 * message. Says what worked and, when something didn't, what the agent said.
 */
export async function testAgent(agent: AgentId, workspace: string | null): Promise<{ ok: boolean; text: string }> {
  let process: AgentProcess | null = null;
  try {
    process = await startAgent(agent, workspace);
    const [server, prefs, version] = await Promise.all([mcpStatus(), loadMcpPrefs(), currentVersion()]);
    const chat = await openChat(
      process.stream,
      {
        onUpdate: () => undefined,
        // A test sends no message, so there's nothing to allow.
        onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      },
      {
        cwd: process.started.cwd,
        mcp: server.running && server.port ? { url: endpoint(server.port), token: prefs.token } : null,
        studioVersion: version ?? "0.0.0",
      },
    );
    chat.close();
    const name = [chat.agent.title, chat.agent.version].filter(Boolean).join(" ");
    logAgentSession(chat.agent.title, "connection test passed");
    return { ok: true, text: `Connected to ${name}. ${MCP_TEXT[chat.mcp]}` };
  } catch (error) {
    const stderr = process ? redact(await process.stderr().catch(() => "")).trim().split("\n").slice(-6).join("\n") : "";
    logAgentSession(agent, `connection test failed: ${errorText(error)}`, "error");
    const reason = isAuthRequired(error) ? "The agent needs you to sign in to it first, in a terminal." : errorText(error);
    return { ok: false, text: `${reason}${stderr ? `\n\n${stderr}` : ""}` };
  } finally {
    await process?.stop().catch(() => undefined);
  }
}
