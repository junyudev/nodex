import type { InboxEntryKind } from "../../../shared/inbox";
import { INBOX_ENTRY_KINDS } from "../../../shared/inbox";
import {
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSelectedIcon,
} from "@/components/ui/dropdown";
import { INBOX_KIND_ICONS } from "./inbox-icon-action";
import { INBOX_KIND_LABELS } from "./inbox-presentation";

/**
 * The message's kind as one glyph that leads Nodex's take on it. Hovering names the kind;
 * clicking lets the user correct it.
 */
export function InboxKindControl({
  kind,
  onChange,
}: {
  readonly kind: InboxEntryKind;
  readonly onChange: (kind: InboxEntryKind | null) => void;
}) {
  const Icon = INBOX_KIND_ICONS[kind];
  return (
    <NodexDropdownMenu
      align="start"
      triggerTooltipContent={`${INBOX_KIND_LABELS[kind]} · change`}
      triggerButton={
        <button
          type="button"
          aria-label={`Kind: ${INBOX_KIND_LABELS[kind]}`}
          className="cursor-interaction -ml-1 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-token-description-foreground hover:bg-token-list-hover-background hover:text-token-foreground"
        >
          <Icon className="icon-xs" />
        </button>
      }
    >
      {INBOX_ENTRY_KINDS.map((option) => {
        const OptionIcon = INBOX_KIND_ICONS[option];
        return (
          <NodexDropdownItem
            key={option}
            leftSlot={<OptionIcon className="icon-xs" />}
            rightSlot={option === kind ? <NodexDropdownSelectedIcon /> : null}
            onSelect={() => onChange(option)}
          >
            {INBOX_KIND_LABELS[option]}
          </NodexDropdownItem>
        );
      })}
    </NodexDropdownMenu>
  );
}
