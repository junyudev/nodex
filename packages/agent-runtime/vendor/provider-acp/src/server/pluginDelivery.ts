import type { SessionPlugins } from "../../../../../../src/shared/agent-plugins/session-plugins.ts";
import type * as EffectAcpSchema from "effect-acp/compat";

/** Agents that advertise HTTP MCP connect to plugin servers directly; others go through the stdio bridge. */
export function acpPluginTransport(
  capabilities: EffectAcpSchema.InitializeResponse["agentCapabilities"],
) {
  return capabilities?.mcpCapabilities?.http === true ? "http" : "stdio";
}

type PluginServer = NonNullable<SessionPlugins["skillCatalog"]>;

export function acpSessionMcpServers(input: {
  readonly capabilities: EffectAcpSchema.InitializeResponse["agentCapabilities"];
  readonly servers: readonly EffectAcpSchema.McpServer[];
  readonly plugins?: {
    readonly delivery: SessionPlugins;
    readonly stdio: (server: PluginServer) => EffectAcpSchema.McpServer;
  };
}): readonly EffectAcpSchema.McpServer[] {
  const { capabilities, servers: base, plugins } = input;
  if (!plugins) return base;
  const { skillCatalog, mcpServers } = plugins.delivery;
  const servers = [...(skillCatalog ? [skillCatalog] : []), ...mcpServers];
  if (acpPluginTransport(capabilities) === "stdio") return [...base, ...servers.map(plugins.stdio)];
  return [
    ...base,
    ...servers.map(({ name, url, bearerToken }) => ({
      type: "http" as const,
      name,
      url,
      headers: [{ name: "Authorization", value: "Bearer " + bearerToken }],
    })),
  ];
}

export function acpPluginSkillInstructions(catalogAttached: boolean): string | undefined {
  if (!catalogAttached) return undefined;
  return [
    "## Nodex plugin skills",
    "Use the `nodex_plugin_skills` MCP server to find installed skills for this Project.",
    "Call `list_plugin_skills` when a task or a skill mention calls for one.",
    "Pass the selected entry’s `installationId` and `skill` to `read_plugin_skill`.",
    "Use its `file` argument to read a supporting file listed in the result, or a file the skill names by a path relative to its directory, such as `../../references/guide.md`.",
  ].join("\n");
}
