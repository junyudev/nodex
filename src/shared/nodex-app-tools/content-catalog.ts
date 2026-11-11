import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { NODEX_APP_TOOLS } from "../nodex-agent-tools/identity";
import { NODEX_AGENT_V6_TOOL_CONTRACTS } from "../nodex-agent-tools/v6-contracts";
import { idempotencyKeySchema } from "./idempotency-key";
import { toolInputSchema } from "./tool-input-schema";

/** Hosted writes add caller-chosen retry keys to the semantic content contracts. */
export const appContentToolContracts = {
  ...NODEX_AGENT_V6_TOOL_CONTRACTS,
  create_pages: {
    ...NODEX_AGENT_V6_TOOL_CONTRACTS.create_pages,
    inputSchema: NODEX_AGENT_V6_TOOL_CONTRACTS.create_pages.inputSchema.safeExtend({
      idempotencyKey: idempotencyKeySchema.optional(),
    }),
  },
  set_page_properties: {
    ...NODEX_AGENT_V6_TOOL_CONTRACTS.set_page_properties,
    inputSchema: NODEX_AGENT_V6_TOOL_CONTRACTS.set_page_properties.inputSchema.safeExtend({
      idempotencyKey: idempotencyKeySchema.optional(),
    }),
  },
  update_page: {
    ...NODEX_AGENT_V6_TOOL_CONTRACTS.update_page,
    inputSchema: NODEX_AGENT_V6_TOOL_CONTRACTS.update_page.inputSchema.safeExtend({
      idempotencyKey: idempotencyKeySchema.optional(),
    }),
  },
  advanced_update_page: {
    ...NODEX_AGENT_V6_TOOL_CONTRACTS.advanced_update_page,
    inputSchema: NODEX_AGENT_V6_TOOL_CONTRACTS.advanced_update_page.inputSchema.safeExtend({
      idempotencyKey: idempotencyKeySchema.optional(),
    }),
  },
  move_pages: {
    ...NODEX_AGENT_V6_TOOL_CONTRACTS.move_pages,
    inputSchema: NODEX_AGENT_V6_TOOL_CONTRACTS.move_pages.inputSchema.safeExtend({
      idempotencyKey: idempotencyKeySchema.optional(),
    }),
  },
  duplicate_page: {
    ...NODEX_AGENT_V6_TOOL_CONTRACTS.duplicate_page,
    inputSchema: NODEX_AGENT_V6_TOOL_CONTRACTS.duplicate_page.inputSchema.safeExtend({
      idempotencyKey: idempotencyKeySchema.optional(),
    }),
  },
};
export const contentToolCatalog: readonly Tool[] = NODEX_APP_TOOLS.map((name) => {
  const contract = appContentToolContracts[name];
  return {
    name,
    description: contract.description,
    inputSchema: toolInputSchema(contract.inputSchema),
  };
});

export const isContentTool = (name: string): name is (typeof NODEX_APP_TOOLS)[number] =>
  Object.hasOwn(appContentToolContracts, name);
