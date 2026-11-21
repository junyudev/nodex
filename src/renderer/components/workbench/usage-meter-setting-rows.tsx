import { settingsMessages } from "./workbench-settings-search-catalog";
import { useIntl } from "@/lib/i18n";
import { NodexSwitch } from "@/components/ui/button";
import { useState } from "react";
import { useUsageMeterSettings } from "@/features/usage-meters/usage-meter-settings";
import { NodexSettingsRow, NodexSettingsSection } from "@/components/ui/settings";

const meters = [
  ["antigravity", "Antigravity"],
  ["claude", "Claude"],
  ["codex", "Codex"],
  ["nodexCredit", settingsMessages.usageMetersNodexCredits],
] as const;

export function UsageMeterSettingRows() {
  const intl = useIntl();
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
    >
      {meters.map(([key, message]) => {
        const label = typeof message === "string" ? message : intl.formatMessage(message);
        return (
          <NodexSettingsRow key={key} label={label}>
            <NodexSwitch
              ariaLabel={label}
              checked={settings[key]}
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
