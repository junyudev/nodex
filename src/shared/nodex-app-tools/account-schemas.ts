import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export const accountSchemas = {
  get_usage_limits: z.strictObject({}),
  consume_usage_reset: z.strictObject({ idempotencyKey: z.string().trim().min(1).max(512) }),
};
const descriptions: Record<keyof typeof accountSchemas, string> = {
  get_usage_limits:
    "Read current Codex account usage windows and available reset credits on this host. Limits are shared across the account. usedPercent is consumed; remaining percent is 100 minus usedPercent, clamped to 0–100. Resets are Unix seconds. Prefer rateLimitsByLimitId when available; null means unavailable, never zero usage. Does not redeem or purchase anything.",
  consume_usage_reset:
    "Redeem one existing Codex usage-reset credit only when the user explicitly asks or has already authorized redemption. Does not purchase credits or reset another account. Use a unique idempotencyKey and reuse exactly that key after an uncertain response. Only outcome reset means a new reset was applied; alreadyRedeemed, noCredit and nothingToReset do not apply a new reset.",
};
export const accountToolCatalog: readonly Tool[] = Object.entries(accountSchemas).map(
  ([name, schema]) => ({
    name,
    description: descriptions[name as keyof typeof descriptions],
    inputSchema: z.toJSONSchema(schema) as Tool["inputSchema"],
    annotations: {
      readOnlyHint: name === "get_usage_limits",
      destructiveHint: name === "consume_usage_reset",
      openWorldHint: true,
    },
  }),
);
