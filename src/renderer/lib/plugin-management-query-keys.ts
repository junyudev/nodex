import type { PluginContext, ResolvedPluginContext } from "../../shared/codex-plugin-management";
export const pluginManagementKeys = {
  all: (hostId: string) => ["plugin-management", hostId] as const,
  context: (context: PluginContext) =>
    ["plugin-management-context", context.hostId, context.projectId] as const,
  capabilities: (context: PluginContext) =>
    ["plugin-management-capabilities", context.hostId, context.projectId] as const,
  scope: (context: ResolvedPluginContext) =>
    [
      "plugin-management",
      context.hostId,
      context.hostGeneration,
      context.accountEpoch,
      context.projectId,
      context.bindingRevision,
      context.cwds,
    ] as const,
  resource: (context: ResolvedPluginContext, resource: string, args: unknown = null) =>
    [...pluginManagementKeys.scope(context), resource, args] as const,
};
