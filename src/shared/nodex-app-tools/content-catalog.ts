import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { NODEX_APP_TOOLS } from "../nodex-agent-tools/identity";
import { NODEX_AGENT_V6_TOOL_CONTRACTS } from "../nodex-agent-tools/v6-contracts";

/** Native transport projects the same semantic content contracts as every Agent client. */
export const contentToolCatalog: readonly Tool[] = NODEX_APP_TOOLS.map((name) => {
  const contract = NODEX_AGENT_V6_TOOL_CONTRACTS[name];
  return {
    name,
    description: contract.description,
    inputSchema: { ...z.toJSONSchema(contract.inputSchema), type: "object" } as Tool["inputSchema"],
  };
});

export const isContentTool = (name: string): name is (typeof NODEX_APP_TOOLS)[number] =>
  Object.hasOwn(NODEX_AGENT_V6_TOOL_CONTRACTS, name);
