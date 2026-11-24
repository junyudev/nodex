import { useIntl } from "@/lib/i18n";
import { useBalanceGauges } from "@/lib/balance-gauge";
import { isHostedChat } from "@/lib/hosted-chat";
import type { UsageReading } from "@/lib/usage-meter";
import {
  providerKeyRuntimeInstanceId,
  type ProviderKeyConnection,
} from "../../../shared/provider-keys";
import type { ProviderKeyUsage } from "../../../shared/provider-key-usage";
import { providerKeyGaugeKey, providerKeyUsageReading } from "./provider-key-usage-model";
import { useProviderKeyUsage } from "./use-provider-key-usage";
import { useProviderKeys } from "./use-provider-keys";

/** One enabled connection whose provider reported usage for its key. */
export interface ProviderKeyUsageAccount {
  readonly connection: ProviderKeyConnection;
  readonly usage: ProviderKeyUsage;
  readonly reading: UsageReading;
}

export interface ProviderKeyUsageAccounts {
  readonly accounts: readonly ProviderKeyUsageAccount[];
  /** The meter reading of a runtime instance that is one of these connections. */
  readonly readingOf: (instanceId: string) => UsageReading | null;
  /** Asks the provider again, no more than once a minute per connection. */
  readonly refresh: (connectionId?: string) => Promise<unknown>;
}

/**
 * API key connections as usage accounts, shared by the rail, the Inbox's plan and Settings. Balance
 * gauges advance here, so every surface measures a balance against the same last top-up.
 */
export function useProviderKeyUsageAccounts(): ProviderKeyUsageAccounts | null {
  const intl = useIntl();
  const usage = useProviderKeyUsage();
  const keys = useProviderKeys(undefined, { enabled: !isHostedChat() });
  const connections = keys.settings?.connections ?? [];
  const reported = (usage?.snapshot?.connections ?? []).flatMap((entry) => {
    const connection = connections.find(({ id, enabled }) => enabled && id === entry.connectionId);
    return connection ? [{ connection, usage: entry }] : [];
  });
  const gauges = useBalanceGauges(
    reported.flatMap(({ connection, usage: entry }) =>
      entry.balance
        ? [{ key: providerKeyGaugeKey(connection.id), balance: entry.balance.amount }]
        : [],
    ),
  );
  if (!usage) return null;
  const accounts = reported.map(({ connection, usage: entry }): ProviderKeyUsageAccount => ({
    connection,
    usage: entry,
    reading: providerKeyUsageReading(
      connection,
      entry,
      gauges.get(providerKeyGaugeKey(connection.id)) ?? null,
      intl,
    ),
  }));
  return {
    accounts,
    readingOf: (instanceId) =>
      accounts.find(({ connection }) => providerKeyRuntimeInstanceId(connection) === instanceId)
        ?.reading ?? null,
    refresh: usage.refresh,
  };
}
