/**
 * Stub for `@scalar/agent-chat`, aliased in at build time.
 *
 * Scalar's Ask-AI agent calls `api.scalar.com` from module scope; the request
 * goes out when the chunk loads, before anything is rendered and regardless of
 * `mcp: { disabled: true }`. Studio is a client for **internal, private** APIs,
 * so a spec opening on someone's laptop must not produce a request to a third
 * party. Configuration couldn't switch it off, so the module isn't shipped.
 *
 * `Chat` is the only binding `AgentScalarChatInterface.vue` imports. It renders
 * nothing; with the agent disabled in configuration the component is never
 * mounted, and this exists so the import resolves rather than to be used.
 */
export const Chat = {
  name: "ScalarAgentChatDisabled",
  render: () => null,
};

export default { Chat };
