import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";

export const SUBSCRIPTION_USAGE_PROVIDERS = ["antigravity", "claude"] as const;
export type SubscriptionUsageProvider = (typeof SUBSCRIPTION_USAGE_PROVIDERS)[number];

type Provider = AgentRuntimeOperations["providers.read"]["output"][number];

/** False for accounts that can never have subscription windows, such as an API key or Bedrock. */
export const hasClaudeSubscriptionLimits = (provider: Provider): boolean =>
  provider.usageLimits?.unavailable?.reason !== "unsupported" &&
  provider.auth.type !== "apiKey" &&
  provider.auth.type !== "bedrock";

export function subscriptionUsageProvider(provider: Provider): SubscriptionUsageProvider | null {
  if (provider.driver === "claudeAgent") return "claude";
  if (provider.driver === "antigravity") return "antigravity";
  return null;
}

/** Enabled Agents that can show a subscription meter for the account they report. */
export function meteredSubscriptionProviders(
  providers: readonly Provider[] | null | undefined,
): readonly Provider[] {
  return (providers ?? []).filter((provider) => {
    if (!provider.enabled || !provider.installed) return false;
    const kind = subscriptionUsageProvider(provider);
    if (kind === "antigravity")
      return (
        (provider.auth.type === "oauth-personal" || provider.auth.type === "oauth-business") &&
        provider.auth.status === "authenticated" &&
        provider.usageLimits?.unavailable?.reason !== "unsupported"
      );
    return (
      kind === "claude" &&
      hasClaudeSubscriptionLimits(provider) &&
      (provider.auth.status === "authenticated" || (provider.usageLimits?.windows.length ?? 0) > 0)
    );
  });
}

/** Epoch milliseconds when this Agent's usage windows were read; null without windows. */
export function subscriptionUsageReadAt(provider: Provider): number | null {
  const limits = provider.usageLimits;
  if (!limits || limits.windows.length === 0) return null;
  const readAt = Date.parse(limits.checkedAt);
  return Number.isFinite(readAt) ? readAt : null;
}
