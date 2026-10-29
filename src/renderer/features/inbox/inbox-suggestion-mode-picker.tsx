import {
  NodexDropdownButtonTrigger,
  NodexOptionPicker,
  NodexSettingsDropdownTrigger,
} from "@/components/ui/dropdown";
import { INBOX_SUGGESTION_MODES, type InboxSuggestionMode } from "../../../shared/inbox";

const MODE_COPY: Readonly<
  Record<InboxSuggestionMode, { readonly label: string; readonly description: string }>
> = {
  automatic: { label: "Automatically", description: "Pauses when usage is about to run out" },
  on_request: { label: "When I ask", description: "Only when you choose Suggest" },
  off: { label: "Off", description: "Handle every message by hand" },
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
  const label = MODE_COPY[value].label;
  return (
    <NodexOptionPicker
      value={value}
      align="end"
      contentWidth="menuWide"
      options={INBOX_SUGGESTION_MODES.map((mode) => ({
        value: mode,
        label: MODE_COPY[mode].label,
        subText: MODE_COPY[mode].description,
      }))}
      onValueChange={(next) => {
        const mode = INBOX_SUGGESTION_MODES.find((candidate) => candidate === next);
        if (mode && mode !== value) onChange(mode);
      }}
      triggerButton={
        trigger === "settings" ? (
          <NodexSettingsDropdownTrigger aria-label="When to suggest">
            {label}
          </NodexSettingsDropdownTrigger>
        ) : (
          <NodexDropdownButtonTrigger
            size="xs"
            chrome="transparent"
            aria-label="When to suggest"
            className="shrink-0 whitespace-nowrap"
          >
            {label}
          </NodexDropdownButtonTrigger>
        )
      }
    />
  );
}
