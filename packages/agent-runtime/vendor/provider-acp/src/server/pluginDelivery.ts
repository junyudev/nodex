import type { SessionPlugins } from "../../../../../../src/shared/agent-plugins/session-plugins.ts";
import type * as EffectAcpSchema from "effect-acp/compat";

export function acpPluginTransport(
  capabilities: EffectAcpSchema.InitializeResponse["agentCapabilities"],
) {
  const http = capabilities?.mcpCapabilities?.http;
  if (http === true) return "http";
  return http === false ? "stdio" : "unverified";
}

type PluginServer = NonNullable<SessionPlugins["skillCatalog"]>;

export function acpSessionMcpServers(input: {
  readonly capabilities: EffectAcpSchema.InitializeResponse["agentCapabilities"];
  readonly servers: readonly EffectAcpSchema.McpServer[];
  readonly acpServers: readonly EffectAcpSchema.McpServer[];
  readonly plugins?: {
    readonly delivery: SessionPlugins;
    readonly stdio: (server: PluginServer) => EffectAcpSchema.McpServer;
  };
}): readonly EffectAcpSchema.McpServer[] {
  const { capabilities, acpServers, plugins } = input;
  const base =
    capabilities?.mcpCapabilities?.acp === true && acpServers.length > 0
      ? acpServers
      : input.servers;
  if (!plugins) return base;
  if (acpPluginTransport(capabilities) !== "http")
    return plugins.delivery.skillCatalog ? [...base, plugins.stdio(plugins.delivery.skillCatalog)] : base;

  return [
    ...base,
    ...[...(plugins.delivery.skillCatalog ? [plugins.delivery.skillCatalog] : []), ...plugins.delivery.mcpServers].map(
      ({ name, url, bearerToken }) => ({
        type: "http" as const,
        name,
        url,
        headers: [{ name: "Authorization", value: "Bearer " + bearerToken }],
      }),
    ),
  ];
}

export function acpPluginSkillInstructions(catalogAttached: boolean): string | undefined {
  if (!catalogAttached) return undefined;
  return [
    "## Nodex plugin skills",
    "Use the `nodex_plugin_skills` MCP server to find installed skills for this Project.",
    "Call `list_plugin_skills` when a task or a skill mention calls for one.",
    "Pass the selected entry’s `installationId` and `skill` to `read_plugin_skill`.",
    "Use its `file` argument to read a supporting file listed in the result.",
  ].join("\n");
}
