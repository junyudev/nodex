import { type MessageDescriptor, defineMessage, useIntl } from "@/lib/i18n";
import {
  NodexDropdownButtonTrigger,
  NodexOptionPicker,
  NodexSettingsDropdownTrigger,
} from "@/components/ui/dropdown";
import { INBOX_SUGGESTION_MODES, type InboxSuggestionMode } from "../../../shared/inbox";

const MODE_COPY: Readonly<
  Record<
    InboxSuggestionMode,
    { readonly label: MessageDescriptor; readonly description: MessageDescriptor }
  >
> = {
  automatic: {
    label: defineMessage({
      id: "inbox.inboxSuggestionModePicker.automatic",
      defaultMessage: "Automatically",
    }),
    description: defineMessage({
      id: "inbox.inboxSuggestionModePicker.automaticDescription",
      defaultMessage: "Pauses when usage is about to run out",
    }),
  },
  on_request: {
    label: defineMessage({
      id: "inbox.inboxSuggestionModePicker.onRequest",
      defaultMessage: "When I ask",
    }),
    description: defineMessage({
      id: "inbox.inboxSuggestionModePicker.onRequestDescription",
      defaultMessage: "Only when you choose Suggest",
    }),
  },
  off: {
    label: defineMessage({ id: "inbox.inboxSuggestionModePicker.off", defaultMessage: "Off" }),
    description: defineMessage({
      id: "inbox.inboxSuggestionModePicker.offDescription",
      defaultMessage: "Handle every message by hand",
    }),
  },
};

/** When suggestions run, chosen the same way in the Inbox's panel and in Settings. */
export function InboxSuggestionModePicker({
  value,
  onChange,
  trigger,
}: {
  readonly value: InboxSuggestionMode;
  readonly onChange: (mode: InboxSuggestionMode) => void;
  /** `compact` sits at a panel section's trailing edge; `settings` ends a Settings row. */
  readonly trigger: "compact" | "settings";
}) {
  const intl = useIntl();
  const label = intl.formatMessage(MODE_COPY[value].label);
  return (
    <NodexOptionPicker
      value={value}
      align="end"
      contentWidth="menuWide"
      options={INBOX_SUGGESTION_MODES.map((mode) => ({
        value: mode,
        label: intl.formatMessage(MODE_COPY[mode].label),
        subText: intl.formatMessage(MODE_COPY[mode].description),
      }))}
      onValueChange={(next) => {
        const mode = INBOX_SUGGESTION_MODES.find((candidate) => candidate === next);
        if (mode && mode !== value) onChange(mode);
      }}
      triggerButton={
        trigger === "settings" ? (
          <NodexSettingsDropdownTrigger
            aria-label={intl.formatMessage({
              id: "inbox.inboxSuggestionModePicker.whenToSuggest",
              defaultMessage: "When to suggest",
            })}
          >
            {label}
          </NodexSettingsDropdownTrigger>
        ) : (
          <NodexDropdownButtonTrigger
            size="xs"
            chrome="transparent"
            aria-label={intl.formatMessage({
              id: "inbox.inboxSuggestionModePicker.whenToSuggest",
              defaultMessage: "When to suggest",
            })}
            className="shrink-0 whitespace-nowrap"
          >
            {label}
          </NodexDropdownButtonTrigger>
        )
      }
    />
  );
}
