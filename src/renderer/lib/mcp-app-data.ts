import { queryOptions } from "@tanstack/react-query";
import type { PluginContext, PluginMutationResult } from "../../shared/codex-plugin-management";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";

const clear = defineRendererCommand({
  key: "mcp-app.data-clear",
  channel: "mcp-app:data:clear",
  authority: "main",
  owner: "McpAppSandboxRuntime",
  protocol: { kind: "returned_value" },
});
export const mcpAppDataCapabilitiesOptions = ({ hostId }: PluginContext) =>
  queryOptions({
    queryKey: ["mcp-app-data-capabilities", hostId],
    queryFn: () => invokeRendererQuery("mcp-app:data:capabilities", { hostId, projectId: null }),
    retry: false,
    staleTime: Infinity,
  });
export const clearMcpAppData = (context: PluginContext): Promise<PluginMutationResult> =>
  invokePlainCommand(clear, context).catch(() => ({
    status: "failed",
    error: {
      code: "mutation_outcome_unknown",
      message: "MCP app data clearing could not be confirmed. Try again.",
      retryable: true,
    },
  }));
