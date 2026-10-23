import { useState } from "react";
import { LocalStatusIcon } from "@/components/shared/icons";
import {
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownMessage,
  NodexDropdownSearchInput,
  NodexDropdownSelectedIcon,
  NodexDropdownSeparator,
} from "@/components/ui/dropdown";
import { COMPOSER_PICKER_ITEM_CLASS_NAME } from "../shared/inline-composer-picker";

/** Agent drafts execute on the local host, independently of their worktree choice. */
export function NewChatLocationSelector({ disabled = false }: { disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const matches = "this computer".includes(search.trim().toLocaleLowerCase());

  return (
    <NodexDropdownMenu
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setSearch("");
      }}
      disabled={disabled}
      side="top"
      align="start"
      contentWidth="panel"
      contentClassName="w-[280px]"
      triggerTooltipContent="Location"
      triggerButton={
        <button
          type="button"
          aria-label="Location"
          disabled={disabled}
          data-new-chat-location-trigger="true"
          className="inline-flex h-7 min-w-0 items-center gap-1.5 rounded-lg border border-transparent px-2 text-sm text-token-foreground outline-hidden hover:bg-token-foreground/5 focus-visible:ring-2 focus-visible:ring-token-focus-border data-popup-open:bg-token-foreground/5 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <LocalStatusIcon className="icon-xs shrink-0" />
          <span className="min-w-0 truncate">This computer</span>
        </button>
      }
    >
      <NodexDropdownSearchInput
        autoFocus={false}
        value={search}
        onChange={(event) => setSearch(event.currentTarget.value)}
        placeholder="Search locations…"
        aria-label="Search locations"
      />
      <NodexDropdownSeparator />
      {matches ? (
        <NodexDropdownItem
          className={COMPOSER_PICKER_ITEM_CLASS_NAME}
          leftSlot={<LocalStatusIcon className="icon-xs shrink-0" />}
          rightSlot={<NodexDropdownSelectedIcon />}
          onSelect={() => setOpen(false)}
        >
          This computer
        </NodexDropdownItem>
      ) : (
        <NodexDropdownMessage compact>No matching locations</NodexDropdownMessage>
      )}
    </NodexDropdownMenu>
  );
}
