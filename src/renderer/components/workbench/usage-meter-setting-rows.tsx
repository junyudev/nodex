import { useSubscriptionUsage } from "@/lib/use-subscription-usage";
import { subscriptionUsageAccounts } from "@/lib/usage-meter";
import { subscriptionMeters } from "../../../shared/subscription-usage";
import { providerKeyMeterPreference } from "../../../shared/provider-key-usage";
import { useProviderKeyUsageAccounts } from "@/features/provider-keys/use-provider-key-usage-accounts";
import { settingsMessages } from "./workbench-settings-search-catalog";
import { useIntl } from "@/lib/i18n";
import { NodexSwitch } from "@/components/ui/button";
import { useState } from "react";
import { useUsageMeterSettings } from "@/features/usage-meters/usage-meter-settings";
import { NodexSettingsRow, NodexSettingsSection } from "@/components/ui/settings";

const defaultMeters = [
  ...subscriptionMeters.map(({ preference, label }) => [preference, label] as const),
  ["codex", "Codex"],
  ["nodexCredit", settingsMessages.usageMetersNodexCredits],
] as const;

export function UsageMeterSettingRows() {
  const intl = useIntl();
  const subscription = useSubscriptionUsage();
  const reported = subscriptionUsageAccounts(subscription?.snapshot);
  const keyUsage = useProviderKeyUsageAccounts();
  const meters = new Map<string, (typeof defaultMeters)[number][1]>(defaultMeters);
  for (const { reading } of reported) {
    if (!meters.has(reading.provider)) meters.set(reading.provider, reading.title);
  }
  // Each API key connection that reports a balance or plan has its own meter.
  for (const { connection } of keyUsage?.accounts ?? [])
    meters.set(providerKeyMeterPreference(connection.id), connection.displayName);
  const {
    settings,
    isLoading,
    isSaving,
    error: loadError,
    updateSettings,
  } = useUsageMeterSettings();
  const [saveError, setSaveError] = useState<string | null>(null);
  const error =
    saveError ??
    (loadError
      ? intl.formatMessage({
          id: "settings.usageMeters.loadFailed",
          defaultMessage: "Could not load usage meter settings.",
        })
      : null);
  return (
    <NodexSettingsSection
      id="usage-meters"
      title={intl.formatMessage(settingsMessages.usageMetersUsageMeters)}
      footnote={intl.formatMessage(settingsMessages.usageMetersFootnote)}
    >
      {[...meters].map(([key, message]) => {
        const label = typeof message === "string" ? message : intl.formatMessage(message);
        return (
          <NodexSettingsRow key={key} label={label}>
            <NodexSwitch
              ariaLabel={label}
              checked={settings[key] !== false}
              disabled={isLoading || isSaving || Boolean(loadError)}
              onCheckedChange={(enabled) => {
                setSaveError(null);
                void updateSettings({ ...settings, [key]: enabled }).catch(() =>
                  setSaveError(
                    intl.formatMessage({
                      id: "settings.usageMeters.couldNotSaveUsageMeterSettings",
                      defaultMessage: "Could not save usage meter settings.",
                    }),
                  ),
                );
              }}
            />
          </NodexSettingsRow>
        );
      })}
      {error ? (
        <span role="alert" className="px-4 py-2 text-xs text-danger">
          {error}
        </span>
      ) : null}
    </NodexSettingsSection>
  );
}
