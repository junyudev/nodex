import { settingsMessages } from "./workbench-settings-search-catalog";
import { getIntl, useIntl, type MessageDescriptor } from "@/lib/i18n";
import { NodexSettingsRow } from "@/components/ui/settings";
import {
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSelectedIcon,
  NodexSettingsDropdownTrigger,
} from "@/components/ui/dropdown";
import { useLinkOpeningSettings } from "@/lib/link-opening-settings";
import type { LinkOpenTarget } from "../../../shared/browser-url-policy";
import type {
  ExternalBrowserLinkShortcut,
  LinkOpeningSettings,
} from "../../../shared/link-opening-settings";

interface ChoiceOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

const DESTINATION_OPTIONS: readonly { value: LinkOpenTarget; label: string | MessageDescriptor }[] =
  [
    { value: "in-app-browser", label: "Nodex" },
    { value: "external-browser", label: settingsMessages.linkOpeningDefaultBrowser },
  ];

function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /^(mac|darwin)/iu.test(navigator.platform);
}

function shortcutOptions(mac: boolean): readonly ChoiceOption<ExternalBrowserLinkShortcut>[] {
  return [
    { value: "unassigned", label: getIntl().formatMessage(settingsMessages.linkOpeningUnassigned) },
    { value: "primary", label: mac ? "⌘+Click" : "Ctrl+Click" },
    { value: "alt", label: mac ? "⌥+Click" : "Alt+Click" },
    { value: "primary-shift", label: mac ? "⇧⌘+Click" : "Ctrl+Shift+Click" },
  ];
}

/** One saved choice, shown as the settings dropdown used across Settings. */
function ChoiceSettingControl<T extends string>({
  label,
  options,
  value,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly options: readonly ChoiceOption<T>[];
  readonly value: T;
  readonly disabled: boolean;
  readonly onChange: (value: T) => void;
}) {
  const intl = useIntl();
  const selected = options.find((option) => option.value === value) ?? options[0];
  return (
    <NodexDropdownMenu
      triggerButton={
        <NodexSettingsDropdownTrigger
          aria-label={intl.formatMessage(
            { id: "settings.linkOpening.text", defaultMessage: "{label}: {value}" },
            { label: label, value: selected?.label ?? "" },
          )}
          className="min-w-40"
          disabled={disabled}
        >
          <span className="truncate">{selected?.label}</span>
        </NodexSettingsDropdownTrigger>
      }
      align="end"
      contentWidth="sm"
    >
      {options.map((option) => (
        <NodexDropdownItem
          key={option.value}
          onSelect={() => onChange(option.value)}
          rightSlot={option.value === value ? <NodexDropdownSelectedIcon /> : null}
        >
          {option.label}
        </NodexDropdownItem>
      ))}
    </NodexDropdownMenu>
  );
}

function useLinkOpeningSetting<K extends keyof LinkOpeningSettings>(key: K) {
  const { settings, isLoading, updateSettings } = useLinkOpeningSettings();
  return {
    value: settings[key],
    disabled: isLoading,
    onChange: (value: LinkOpeningSettings[K]) => {
      if (value === settings[key]) return;
      void updateSettings({ ...settings, [key]: value }).catch(() => undefined);
    },
  };
}

/** Where web links and local development sites open, in the Browser settings. */
export function LinkDestinationSettingRows() {
  const intl = useIntl();
  const web = useLinkOpeningSetting("openLinkInTarget");
  const local = useLinkOpeningSetting("openLocalUrlInTarget");
  return (
    <>
      <NodexSettingsRow
        label={intl.formatMessage(settingsMessages.linkOpeningWebURLAndLinkOpenDestination)}
      >
        <ChoiceSettingControl
          label={intl.formatMessage(settingsMessages.linkOpeningWebURLAndLinkOpenDestination)}
          options={DESTINATION_OPTIONS.map((option) => ({
            ...option,
            label:
              typeof option.label === "string" ? option.label : intl.formatMessage(option.label),
          }))}
          {...web}
        />
      </NodexSettingsRow>
      <NodexSettingsRow
        label={intl.formatMessage(settingsMessages.linkOpeningLocalURLOpenDestination)}
        description={intl.formatMessage(
          settingsMessages.linkOpeningWhereLocalDevelopmentSitesOpenBy,
        )}
      >
        <ChoiceSettingControl
          label={intl.formatMessage(settingsMessages.linkOpeningLocalURLOpenDestination)}
          options={DESTINATION_OPTIONS.map((option) => ({
            ...option,
            label:
              typeof option.label === "string" ? option.label : intl.formatMessage(option.label),
          }))}
          {...local}
        />
      </NodexSettingsRow>
    </>
  );
}

/** The click modifier that sends a web link to the system browser, in Keyboard shortcuts. */
export function ExternalBrowserLinkShortcutSettingRow() {
  const intl = useIntl();
  const shortcut = useLinkOpeningSetting("externalBrowserLinkShortcut");
  return (
    <NodexSettingsRow
      label={intl.formatMessage(settingsMessages.linkOpeningOpenWebLinkInDefaultBrowser)}
      description={intl.formatMessage(settingsMessages.linkOpeningHoldTheAssignedKeysWhileClicking)}
    >
      <ChoiceSettingControl
        label={intl.formatMessage(settingsMessages.linkOpeningOpenWebLinkInDefaultBrowser)}
        options={shortcutOptions(isMacPlatform())}
        {...shortcut}
      />
    </NodexSettingsRow>
  );
}
