/**
 * Compatibility metadata for ACP packages the product knows how to launch.
 *
 * The current distribution is user-managed: these fields do not attest the bytes at a configured
 * local path. A future managed distribution must use a separate immutable artifact lock and
 * materializer rather than adding registry integrity metadata to this compatibility record.
 */
export const CLAUDE_ACP_AGENT_DEFINITION = {
  id: "claude-agent-acp",
  title: "Claude Agent",
  packageName: "@agentclientprotocol/claude-agent-acp",
  packageVersion: "0.73.0",
  entryRelativePath: "dist/index.js",
  minimumNodeMajor: 22,
  distribution: "user-managed-local-package",
} as const;

export const ACP_AGENT_DEFINITIONS = [CLAUDE_ACP_AGENT_DEFINITION] as const;

export type AcpAgentDefinitionId = (typeof ACP_AGENT_DEFINITIONS)[number]["id"];
