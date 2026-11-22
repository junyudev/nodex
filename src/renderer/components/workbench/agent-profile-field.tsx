import { useIntl } from "@/lib/i18n";
import type { AgentProfileField, ProfileValues } from "../../../shared/agents/profile-definition";
import {
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSelectedIcon,
  NodexSettingsDropdownTrigger,
} from "../ui/dropdown";
import { Input } from "../ui/input";
import { NodexSettingsRow } from "../ui/settings";

export const agentProfileInputClassName = "h-8 w-[min(28rem,45vw)] text-sm";

export function AgentProfileFieldRow({
  field,
  value,
  settings,
  saved,
  disabled,
  onChange,
}: {
  readonly field: Exclude<AgentProfileField, { control: "custom" }>;
  readonly value: unknown;
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
            <NodexSettingsDropdownTrigger className="min-w-52" aria-label={label}>
              <span className="truncate">{selected && intl.formatMessage(selected.label)}</span>
            </NodexSettingsDropdownTrigger>
          }
        >
          {field.options.map((option) => (
            <NodexDropdownItem
              key={option.value}
              onSelect={() => onChange(option.value)}
              rightSlot={option.value === value ? <NodexDropdownSelectedIcon /> : null}
            >
              <span className="truncate">{intl.formatMessage(option.label)}</span>
            </NodexDropdownItem>
          ))}
        </NodexDropdownMenu>
      ) : (
        <Input
          type={field.control === "secret" ? "password" : undefined}
          aria-label={label}
          className={agentProfileInputClassName}
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
