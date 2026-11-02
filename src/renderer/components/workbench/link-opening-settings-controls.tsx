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

const DESTINATION_OPTIONS: readonly ChoiceOption<LinkOpenTarget>[] = [
  { value: "in-app-browser", label: "Nodex" },
  { value: "external-browser", label: "Default browser" },
];

function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /^(mac|darwin)/iu.test(navigator.platform);
}

function shortcutOptions(mac: boolean): readonly ChoiceOption<ExternalBrowserLinkShortcut>[] {
  return [
    { value: "unassigned", label: "Unassigned" },
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
  const selected = options.find((option) => option.value === value) ?? options[0];
  return (
    <NodexDropdownMenu
      triggerButton={
        <NodexSettingsDropdownTrigger
          aria-label={`${label}: ${selected?.label ?? ""}`}
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
  const web = useLinkOpeningSetting("openLinkInTarget");
  const local = useLinkOpeningSetting("openLocalUrlInTarget");
  return (
    <>
      <NodexSettingsRow label="Web URL and link open destination">
        <ChoiceSettingControl
          label="Web URL and link open destination"
          options={DESTINATION_OPTIONS}
          {...web}
        />
      </NodexSettingsRow>
      <NodexSettingsRow
        label="Local URL open destination"
        description="Where local development sites open by default"
      >
        <ChoiceSettingControl
          label="Local URL open destination"
          options={DESTINATION_OPTIONS}
          {...local}
        />
      </NodexSettingsRow>
    </>
  );
}

/** The click modifier that sends a web link to the system browser, in Keyboard shortcuts. */
export function ExternalBrowserLinkShortcutSettingRow() {
  const shortcut = useLinkOpeningSetting("externalBrowserLinkShortcut");
  return (
    <NodexSettingsRow
      label="Open web link in default browser"
      description="Hold the assigned keys while clicking a web link to open it in your default system browser"
    >
      <ChoiceSettingControl
        label="Open web link in default browser"
        options={shortcutOptions(isMacPlatform())}
        {...shortcut}
      />
    </NodexSettingsRow>
  );
}
