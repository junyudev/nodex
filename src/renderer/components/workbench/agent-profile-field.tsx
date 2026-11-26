import { useIntl } from "@/lib/i18n";
import type { AgentProfileField, ProfileValues } from "../../../shared/agents/profile-definition";
import {
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSelectedIcon,
  NodexSettingsDropdownTrigger,
} from "../ui/dropdown";
import { Input } from "../ui/input";
import { NODEX_SETTINGS_FIELD_CLASS_NAME, NodexSettingsRow } from "../ui/settings";

export function AgentProfileFieldRow({
  field,
  value,
  heldBy,
  settings,
  saved,
  disabled,
  onChange,
}: {
  readonly field: Exclude<AgentProfileField, { control: "custom" }>;
  readonly value: unknown;
  /** Another profile's name for each exclusive option it already uses. */
  readonly heldBy?: ReadonlyMap<string, string>;
  readonly settings: ProfileValues;
  readonly saved: boolean;
  readonly disabled: boolean;
  readonly onChange: (value: string | null) => void;
}) {
  const intl = useIntl();
  if (field.when && !field.when(settings)) return null;
  const label = intl.formatMessage(field.accessibleLabel);
  const description =
    typeof field.description === "function" ? field.description(settings) : field.description;
  const text = typeof value === "string" ? value : "";
  const selected =
    field.control === "select" ? field.options.find((option) => option.value === value) : undefined;
  const placeholder =
    field.control === "secret" && saved && value === null
      ? field.savedPlaceholder
      : field.placeholder;
  return (
    <NodexSettingsRow
      variant="nested"
      label={intl.formatMessage(field.label)}
      description={description && intl.formatMessage(description)}
    >
      {field.control === "select" ? (
        <NodexDropdownMenu
          disabled={disabled}
          contentWidth="menuWide"
          align="end"
          triggerButton={
            <NodexSettingsDropdownTrigger
              className="w-64 max-w-full justify-between"
              aria-label={label}
            >
              <span className="truncate">{selected && intl.formatMessage(selected.label)}</span>
            </NodexSettingsDropdownTrigger>
          }
        >
          {field.options.map((option) => {
            const holder = option.value === value ? undefined : heldBy?.get(option.value);
            return (
              <NodexDropdownItem
                key={option.value}
                disabled={holder !== undefined}
                onSelect={() => onChange(option.value)}
                rightSlot={
                  option.value === value ? (
                    <NodexDropdownSelectedIcon />
                  ) : holder ? (
                    <span className="max-w-32 truncate text-xs text-token-description-foreground">
                      {intl.formatMessage(
                        {
                          id: "settings.agentProfiles.optionUsedBy",
                          defaultMessage: "Used by {profile}",
                        },
                        { profile: holder },
                      )}
                    </span>
                  ) : null
                }
              >
                <span className="truncate">{intl.formatMessage(option.label)}</span>
              </NodexDropdownItem>
            );
          })}
        </NodexDropdownMenu>
      ) : (
        <Input
          variant="settings"
          type={field.control === "secret" ? "password" : undefined}
          aria-label={label}
          className={NODEX_SETTINGS_FIELD_CLASS_NAME}
          value={text}
          disabled={disabled}
          placeholder={
            typeof placeholder === "object" ? intl.formatMessage(placeholder) : placeholder
          }
          autoComplete={field.control === "secret" ? "off" : undefined}
          spellCheck={false}
          onChange={(event) => {
            const value = event.target.value;
            const keepEmpty = field.control === "secret" ? saved : field.empty === "null";
            onChange(value === "" && keepEmpty ? null : value);
          }}
        />
      )}
    </NodexSettingsRow>
  );
}
