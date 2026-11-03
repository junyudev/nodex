import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { NodexOptionPicker, NodexSettingsDropdownTrigger } from "@/components/ui/dropdown";
import { NodexSettingsRow } from "@/components/ui/settings";
import { readSettingsHostPresentation } from "@/lib/settings-host-presentation";
import { useTerminalShellSettings } from "@/lib/terminal-shell-settings";
import { readTerminalShells } from "@/lib/workbench-settings-runtime";
import {
  WINDOWS_TERMINAL_SHELL_LABELS,
  WindowsTerminalShellSchema,
} from "../../../shared/terminal-shell-settings";

function WindowsTerminalShellSettingRow() {
  const {
    settings,
    isLoading,
    isSaving,
    error: loadError,
    updateSettings,
  } = useTerminalShellSettings();
  const shells = useQuery({
    queryKey: ["terminal", "shells"],
    queryFn: async () => WindowsTerminalShellSchema.array().parse(await readTerminalShells()),
    staleTime: 0,
    refetchOnMount: "always",
  });
  const [saveError, setSaveError] = useState<string | null>(null);
  const selected = settings.windowsShell;
  const unavailable =
    selected !== "automatic" && shells.isSuccess && !shells.data.includes(selected);
  const label = selected === "automatic" ? "Automatic" : WINDOWS_TERMINAL_SHELL_LABELS[selected];
  const selectedLabel = unavailable ? `${label} (unavailable)` : label;
  const options = [
    { value: "automatic", label: "Automatic" },
    ...(shells.data ?? []).map((shell) => ({
      value: shell,
      label: WINDOWS_TERMINAL_SHELL_LABELS[shell],
    })),
    ...(unavailable ? [{ value: selected, label: selectedLabel, disabled: true }] : []),
  ];
  const error =
    saveError ?? (loadError || shells.isError ? "Could not load terminal shells." : null);
  return (
    <NodexSettingsRow label="Terminal shell" description="Applies to new terminals.">
      <div className="flex items-center gap-2">
        {error ? (
          <span role="alert" className="max-w-72 text-xs text-danger">
            {error}
          </span>
        ) : null}
        <NodexOptionPicker
          value={selected}
          options={options}
          search="none"
          align="end"
          contentWidth="sm"
          disabled={
            isLoading || isSaving || shells.isPending || Boolean(loadError) || shells.isError
          }
          triggerButton={
            <NodexSettingsDropdownTrigger aria-label={`Terminal shell: ${selectedLabel}`}>
              <span className={unavailable ? "text-token-text-secondary" : undefined}>
                {selectedLabel}
              </span>
            </NodexSettingsDropdownTrigger>
          }
          onValueChange={(value) => {
            const windowsShell =
              value === "automatic" ? value : WindowsTerminalShellSchema.parse(value);
            setSaveError(null);
            void updateSettings({ windowsShell }).catch(() =>
              setSaveError("Could not save terminal shell."),
            );
          }}
        />
      </div>
    </NodexSettingsRow>
  );
}

export function TerminalShellSettingRow() {
  if (!readSettingsHostPresentation().terminalShell) return null;
  return <WindowsTerminalShellSettingRow />;
}
