import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export const uninstallPluginSchema = z.strictObject({ plugin: z.string().trim().min(1).max(512) });
export const uninstallPluginTool: Tool = {
  name: "uninstall_plugin",
  description:
    "Uninstall a Codex plugin only when explicitly requested by the user. Supply its exact installed ID or name. Ambiguous names return candidates without changing anything; retry with the selected exact ID. Nodex-managed desktop plugins cannot be removed through this tool. Reports uninstalled only after reading back the installed inventory.",
  inputSchema: z.toJSONSchema(uninstallPluginSchema) as Tool["inputSchema"],
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
};
