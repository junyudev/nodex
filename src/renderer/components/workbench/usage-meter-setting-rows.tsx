import { NodexSwitch } from "@/components/ui/button";
import { useState } from "react";
import { useUsageMeterSettings } from "@/features/usage-meters/usage-meter-settings";
import { NodexSettingsRow, NodexSettingsSection } from "@/components/ui/settings";

const meters = [
  ["claude", "Claude"],
  ["codex", "Codex"],
  ["nodexCredit", "Nodex credit"],
] as const;

export function UsageMeterSettingRows() {
  const {
    settings,
    isLoading,
    isSaving,
    error: loadError,
    updateSettings,
  } = useUsageMeterSettings();
  const [saveError, setSaveError] = useState<string | null>(null);
  const error = saveError ?? (loadError ? "Could not load usage meter settings." : null);
  return (
    <NodexSettingsSection id="usage-meters" title="Usage meters">
      {meters.map(([key, label]) => (
        <NodexSettingsRow key={key} label={label}>
          <NodexSwitch
            ariaLabel={label}
            checked={settings[key]}
            disabled={isLoading || isSaving || Boolean(loadError)}
            onCheckedChange={(enabled) => {
              setSaveError(null);
              void updateSettings({ ...settings, [key]: enabled }).catch(() =>
                setSaveError("Could not save usage meter settings."),
              );
            }}
          />
        </NodexSettingsRow>
      ))}
      {error ? (
        <span role="alert" className="px-4 py-2 text-xs text-danger">
          {error}
        </span>
      ) : null}
    </NodexSettingsSection>
  );
}
