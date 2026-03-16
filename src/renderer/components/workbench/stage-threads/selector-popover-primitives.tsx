import type { ReactNode } from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { ChevronDownIcon } from "../../shared/icons";
import { SELECTOR_MENU_CONTENT_CLASS_NAME } from "../../ui/selector-menu-chrome";
import { cn } from "../../../lib/utils";
export {
  SELECTOR_MENU_CONTENT_CLASS_NAME,
  SELECTOR_MENU_DIVIDER_CLASS_NAME,
  SELECTOR_MENU_DIVIDER_WRAPPER_CLASS_NAME,
  SELECTOR_MENU_ITEM_CLASS_NAME,
  SELECTOR_MENU_LIST_CLASS_NAME,
  SELECTOR_MENU_PANEL_CLASS_NAME,
  SELECTOR_MENU_TITLE_CLASS_NAME,
} from "../../ui/selector-menu-chrome";

interface SelectorPopoverTriggerProps {
  ariaLabel: string;
  title: string;
  label: string;
  icon: ReactNode;
  disabled: boolean;
  className?: string;
}

export function SelectorPopoverTrigger({
  ariaLabel,
  title,
  label,
  icon,
  disabled,
  className,
}: SelectorPopoverTriggerProps) {
  return (
    <PopoverPrimitive.Trigger asChild>
      <button
        type="button"
        disabled={disabled}
        className={cn(
          "inline-flex h-7 items-center gap-1 rounded-full border border-transparent px-1.5 text-sm/4.5 text-token-description-foreground hover:bg-token-foreground/5 hover:text-token-foreground",
          disabled && "cursor-default opacity-60",
          className,
        )}
        aria-label={ariaLabel}
        title={title}
      >
        {icon}
        <span className="max-w-40 truncate text-sm">{label}</span>
        <ChevronDownIcon />
      </button>
    </PopoverPrimitive.Trigger>
  );
}

interface SelectorPopoverContentProps {
  children: ReactNode;
  className?: string;
}

export function SelectorPopoverContent({
  children,
  className,
}: SelectorPopoverContentProps) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        className={cn(
          SELECTOR_MENU_CONTENT_CLASS_NAME,
          "outline-none",
          className,
        )}
      >
        {children}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
}
