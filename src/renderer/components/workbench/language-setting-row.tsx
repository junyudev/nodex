import { useState } from "react";
import { NodexOptionPicker, NodexSettingsDropdownTrigger } from "@/components/ui/dropdown";
import { NodexSettingsRow } from "@/components/ui/settings";
import { useAppLocale, useIntl } from "@/lib/i18n";
import { useLanguageSettings } from "@/lib/use-language-settings";
import {
  APP_LOCALES,
  localeDisplayName,
  parseAppLocalePreference,
} from "../../../shared/i18n/locales";

const AUTO_DETECT = "auto";

export function LanguageSettingRow() {
  const intl = useIntl();
  const locale = useAppLocale();
  const { preference, isLoading, updatePreference } = useLanguageSettings();
  const [saveError, setSaveError] = useState<string | null>(null);
  const autoDetectLabel = intl.formatMessage({
    id: "settings.ide.language.autoOption",
    defaultMessage: "Auto detect",
    description: "Option that follows the operating system's language",
  });
  // Each language keeps its own name so a person can find theirs from any UI language.
  const languages = APP_LOCALES.map((code) => ({
    value: code,
    label: localeDisplayName(code, code),
    tooltipText: code === locale ? undefined : localeDisplayName(code, locale),
  })).sort((left, right) => left.label.localeCompare(right.label));
  const selectedLabel =
    preference === null ? autoDetectLabel : localeDisplayName(preference, preference);
  return (
    <NodexSettingsRow
      label={intl.formatMessage({
        id: "settings.ide.language.label",
        defaultMessage: "Language",
        description: "Label for the display language setting",
      })}
      description={intl.formatMessage({
        id: "settings.ide.language.description",
        defaultMessage: "Language for the app UI",
        description: "Description for the display language setting",
      })}
    >
      <div className="flex items-center gap-2">
        {saveError ? (
          <span role="alert" className="max-w-72 text-xs text-danger">
            {saveError}
          </span>
        ) : null}
        <NodexOptionPicker
          value={preference ?? AUTO_DETECT}
          options={[{ value: AUTO_DETECT, label: autoDetectLabel }, ...languages]}
          align="end"
          contentWidth="sm"
          disabled={isLoading}
          triggerButton={
            <NodexSettingsDropdownTrigger>
              <span className="truncate">{selectedLabel}</span>
            </NodexSettingsDropdownTrigger>
          }
          onValueChange={(value) => {
            setSaveError(null);
            void updatePreference(parseAppLocalePreference(value)).catch(() => {
              setSaveError(
                intl.formatMessage({
                  id: "settings.ide.language.saveError",
                  defaultMessage: "Could not save language",
                  description: "Error shown when the display language setting fails to save",
                }),
              );
            });
          }}
        />
      </div>
    </NodexSettingsRow>
  );
}
