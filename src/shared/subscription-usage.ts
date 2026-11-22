import { agentDefinition, agentDefinitions } from "./agents/registry";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";

type Provider = AgentRuntimeOperations["providers.read"]["output"][number];

export const subscriptionMeters = agentDefinitions
  .flatMap((definition) =>
    definition.capabilities.subscriptionUsage && definition.usageMeter
      ? [{ ...definition.usageMeter, driver: definition.driver }]
      : [],
  )
  .toSorted((left, right) => left.preference.localeCompare(right.preference));

export const SUBSCRIPTION_USAGE_PROVIDERS = subscriptionMeters.map(({ preference }) => preference);
export const subscriptionMeter = (preference: string) =>
  subscriptionMeters.find((meter) => meter.preference === preference);

export const hasSubscriptionLimits = (provider: Provider): boolean =>
  provider.usageLimits?.unavailable?.reason !== "unsupported" &&
  provider.auth.type !== "apiKey" &&
  provider.auth.type !== "bedrock";

export function subscriptionUsageProvider(provider: Provider): string | null {
  const definition = agentDefinition(provider.driver);
  if (definition.usageFromAccountControl) return null;
  if (!definition.capabilities.subscriptionUsage && !provider.usageLimits) return null;
  return definition.usageMeter?.preference ?? (definition.driver || provider.driver);
}

/** Enabled Agents that can show a subscription meter for the account they report. */
export function meteredSubscriptionProviders(
  providers: readonly Provider[] | null | undefined,
): readonly Provider[] {
  return (providers ?? []).filter((provider) => {
    if (
      !provider.enabled ||
      !provider.installed ||
      !subscriptionUsageProvider(provider) ||
      !hasSubscriptionLimits(provider)
    )
      return false;
    const accountTypes = agentDefinition(provider.driver).usageMeter?.accountTypes;
    if (accountTypes)
      return (
        provider.auth.status === "authenticated" && accountTypes.includes(provider.auth.type ?? "")
      );
    return (
      provider.auth.status === "authenticated" || (provider.usageLimits?.windows.length ?? 0) > 0
    );
  });
}

/**
 * Saved profiles whose accounts can report subscription usage, by meter preference. A profile
 * signed in with an account type that reports none, such as an API key, is left out.
 */
export function declaredSubscriptionAgents(
  profiles: readonly {
    readonly id: string;
    readonly driver: string;
    readonly enabled: boolean;
    readonly settings: Readonly<Record<string, unknown>>;
  }[],
): Record<string, string[]> {
  const declared: Record<string, string[]> = {};
  for (const { usageMeter } of agentDefinitions)
    if (usageMeter?.trackedBySettings) declared[usageMeter.preference] = [];
  for (const profile of profiles) {
    const meter = agentDefinition(profile.driver).usageMeter;
    const ids = meter?.trackedBySettings ? declared[meter.preference] : undefined;
    if (!meter || !ids || !profile.enabled) continue;
    const accountType = meter.accountTypeSetting && profile.settings[meter.accountTypeSetting];
    if (meter.accountTypes && !meter.accountTypes.includes(String(accountType ?? ""))) continue;
    ids.push(profile.id);
  }
  return declared;
}

/** Epoch milliseconds when this Agent's usage windows were read; null without windows. */
export function subscriptionUsageReadAt(provider: Provider): number | null {
  const limits = provider.usageLimits;
  if (!limits || limits.windows.length === 0) return null;
  const readAt = Date.parse(limits.checkedAt);
  return Number.isFinite(readAt) ? readAt : null;
}
