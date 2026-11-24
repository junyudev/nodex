import { getIntl, type IntlShape } from "@/lib/i18n";
import { balanceGaugePercent, type BalanceGauge } from "@/lib/balance-gauge";
import {
  formatRateLimitWindowLabel,
  formatUsageBalance,
  type UsageReading,
} from "@/lib/usage-meter";
import {
  providerKeyRuntimeInstanceId,
  type ProviderKeyConnection,
} from "../../../shared/provider-keys";
import type { ProviderKeyUsage } from "../../../shared/provider-key-usage";

/** Where a connection's balance gauge is kept between windows. */
export const providerKeyGaugeKey = (connectionId: string) => `apiKey:${connectionId}`;

/**
 * A connection's usage as one account meter: its own mark and name, the key it reads with, a
 * plan's windows and the balance against its last top-up.
 */
export function providerKeyUsageReading(
  connection: ProviderKeyConnection,
  usage: ProviderKeyUsage,
  gauge: BalanceGauge | null,
  intl: IntlShape = getIntl(),
): UsageReading {
  return {
    provider: connection.agent,
    instanceId: providerKeyRuntimeInstanceId(connection),
    key: providerKeyGaugeKey(connection.id),
    title: connection.displayName,
    account: connection.keyHint
      ? intl.formatMessage(
          {
            id: "providerKeys.providerKeyUsage.keyAccount",
            defaultMessage: "API key ••••{hint}",
          },
          { hint: connection.keyHint },
        )
      : null,
    plan: null,
    metered: true,
    windows: usage.windows.map((window) => ({
      id: window.id,
      label: formatRateLimitWindowLabel(window.durationMins) ?? window.id,
      usedPercent: window.usedPercent,
      resetsAt: window.resetsAt,
      durationMins: window.durationMins,
      scope: "account",
    })),
    observedAt: usage.observedAt,
    readFailed: usage.readFailed,
    credits: null,
    balance: usage.balance
      ? {
          ...usage.balance,
          remainingPercent: gauge ? balanceGaugePercent(gauge) : null,
        }
      : null,
  };
}

/** A connection's balance for its settings row, such as `¥2.90 left`; null without one. */
export function providerKeyBalanceLabel(
  usage: ProviderKeyUsage | undefined,
  intl: IntlShape = getIntl(),
): string | null {
  if (!usage?.balance) return null;
  return usage.balance.amount <= 0
    ? intl.formatMessage({
        id: "providerKeys.providerKeyUsage.balanceUsedUp",
        defaultMessage: "Balance used up",
      })
    : intl.formatMessage(
        { id: "providerKeys.providerKeyUsage.balanceLeft", defaultMessage: "{balance} left" },
        { balance: formatUsageBalance(usage.balance, intl.locale) },
      );
}
