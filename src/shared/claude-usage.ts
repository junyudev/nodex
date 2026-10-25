import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";

type Provider = AgentRuntimeOperations["providers.read"]["output"][number];

/** False for accounts that can never have subscription windows, such as an API key or Bedrock. */
export const hasClaudeSubscriptionLimits = (provider: Provider): boolean =>
  provider.usageLimits?.unavailable?.reason !== "unsupported" &&
  provider.auth.type !== "apiKey" &&
  provider.auth.type !== "bedrock";

/**
 * The Claude Agents worth a usage meter: enabled, installed, able to have subscription limits,
 * and signed in or holding a reading. Main keeps exactly these current.
 */
export function meteredClaudeProviders(
  providers: readonly Provider[] | null | undefined,
): readonly Provider[] {
  return (providers ?? []).filter(
    (provider) =>
      provider.driver === "claudeAgent" &&
      provider.enabled &&
      provider.installed &&
      hasClaudeSubscriptionLimits(provider) &&
      (provider.auth.status === "authenticated" || (provider.usageLimits?.windows.length ?? 0) > 0),
  );
}

/** Epoch milliseconds when this Agent's usage windows were read; null without windows. */
export function claudeUsageReadAt(provider: Provider): number | null {
  const limits = provider.usageLimits;
  if (!limits || limits.windows.length === 0) return null;
  const readAt = Date.parse(limits.checkedAt);
  return Number.isFinite(readAt) ? readAt : null;
}
