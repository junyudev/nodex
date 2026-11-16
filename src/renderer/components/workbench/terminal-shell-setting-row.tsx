import { settingsMessages } from "./workbench-settings-search-catalog";
import { useIntl } from "@/lib/i18n";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { NodexOptionPicker, NodexSettingsDropdownTrigger } from "@/components/ui/dropdown";
import { NodexSettingsRow } from "@/components/ui/settings";
import { readSettingsHostPresentation } from "@/lib/settings-host-presentation";
import { useTerminalShellSettings } from "@/lib/terminal-shell-settings";
import { readTerminalShells } from "@/lib/workbench-settings-runtime";
import {
  WINDOWS_TERMINAL_SHELL_LABEL_MESSAGES,
  WINDOWS_TERMINAL_SHELL_LABELS,
  WindowsTerminalShellSchema,
} from "../../../shared/terminal-shell-settings";

function WindowsTerminalShellSettingRow() {
  const intl = useIntl();
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
  const label =
    selected === "automatic"
      ? intl.formatMessage(settingsMessages.terminalShellAutomatic)
      : selected === "cmd"
        ? intl.formatMessage(WINDOWS_TERMINAL_SHELL_LABEL_MESSAGES.cmd)
        : WINDOWS_TERMINAL_SHELL_LABELS[selected];
  const selectedLabel = unavailable
    ? intl.formatMessage(
        { id: "settings.terminalShell.unavailable", defaultMessage: "{label} (unavailable)" },
        { label: label },
      )
    : label;
  const options = [
    { value: "automatic", label: intl.formatMessage(settingsMessages.terminalShellAutomatic) },
    ...(shells.data ?? []).map((shell) => ({
      value: shell,
      label:
        shell === "cmd"
          ? intl.formatMessage(WINDOWS_TERMINAL_SHELL_LABEL_MESSAGES.cmd)
          : WINDOWS_TERMINAL_SHELL_LABELS[shell],
    })),
    ...(unavailable ? [{ value: selected, label: selectedLabel, disabled: true }] : []),
  ];
  const error =
    saveError ??
    (loadError || shells.isError
      ? intl.formatMessage({
          id: "settings.terminalShell.loadFailed",
          defaultMessage: "Could not load terminal shells.",
        })
      : null);
  return (
    <NodexSettingsRow
      label={intl.formatMessage(settingsMessages.terminalShellTerminalShell)}
      description={intl.formatMessage(settingsMessages.terminalShellAppliesToNewTerminals)}
    >
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
            <NodexSettingsDropdownTrigger
              aria-label={intl.formatMessage(
                {
                  id: "settings.terminalShell.terminalShell2",
                  defaultMessage: "Terminal shell: {selectedLabel}",
                },
                { selectedLabel: selectedLabel },
              )}
            >
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
              setSaveError(
                intl.formatMessage({
                  id: "settings.terminalShell.couldNotSaveTerminalShell",
                  defaultMessage: "Could not save terminal shell.",
                }),
              ),
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
