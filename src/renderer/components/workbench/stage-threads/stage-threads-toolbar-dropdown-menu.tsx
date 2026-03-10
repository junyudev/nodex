import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import { cn } from "../../../lib/utils";
import { CheckmarkIcon, ChevronDownIcon } from "@/components/shared/icons";
import {
  SELECTOR_MENU_CONTENT_CLASS_NAME,
  SELECTOR_MENU_ITEM_CLASS_NAME,
  SELECTOR_MENU_LIST_CLASS_NAME,
  SELECTOR_MENU_PANEL_CLASS_NAME,
  SELECTOR_MENU_TITLE_CLASS_NAME,
} from "./selector-popover-primitives";

const ToolbarDropdown = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<"button"> & {
    label: string;
    ariaLabel?: string;
  }
>(function ToolbarDropdown(
  {
    label,
    className,
    ariaLabel,
    type = "button",
    ...props
  },
  ref,
) {
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      aria-label={ariaLabel}
      className={cn(
        "inline-flex h-7 items-center gap-1 rounded-full border border-transparent px-2 text-sm/4.5 text-token-description-foreground hover:bg-token-foreground/5 hover:text-token-foreground",
        className,
      )}
    >
      <span>{label}</span>
      <ChevronDownIcon />
    </button>
  );
});

function ToolbarMenuItem({
  label,
  description,
  selected,
  icon,
  multiline,
}: {
  label: string;
  description?: string;
  selected: boolean;
  icon?: ReactNode;
  multiline?: boolean;
}) {
  return (
    <div className="flex w-full items-center gap-1.5">
      {icon ? <span className="text-token-foreground">{icon}</span> : null}
      <span className="min-w-0 flex-1 truncate">
        <span className={cn("flex items-center gap-1 tabular-nums", multiline && "flex-col items-start gap-0.5")}>
          <span className="truncate">{label}</span>
          {description && multiline ? (
            <span className="truncate text-xs text-token-description-foreground">{description}</span>
          ) : null}
        </span>
      </span>
      {selected ? <CheckmarkIcon className="shrink-0 text-token-foreground" /> : null}
    </div>
  );
}

export function ToolbarDropdownMenu({
  label,
  title,
  ariaLabel,
  className,
  items,
  selectedValue,
  onSelect,
  emptyLabel,
  renderItemIcon,
  showDescriptions = false,
  selectedItemDataAttribute,
}: {
  label: string;
  title: string;
  ariaLabel: string;
  className?: string;
  items: Array<{ value: string; label: string; description?: string }>;
  selectedValue: string;
  onSelect: (value: string) => void;
  emptyLabel?: string;
  renderItemIcon?: (value: string) => ReactNode;
  showDescriptions?: boolean;
  selectedItemDataAttribute?: string;
}) {
  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <ToolbarDropdown label={label} className={className} ariaLabel={ariaLabel} />
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className={cn(
            SELECTOR_MENU_CONTENT_CLASS_NAME,
            "max-h-[min(20rem,var(--radix-dropdown-menu-content-available-height,20rem))] outline-none",
          )}
        >
          <div className={cn(SELECTOR_MENU_PANEL_CLASS_NAME, "min-w-40")}>
            <div className={SELECTOR_MENU_TITLE_CLASS_NAME}>{title}</div>
            <div className={SELECTOR_MENU_LIST_CLASS_NAME}>
              {items.length === 0 ? (
                <div className="px-[var(--padding-row-x)] py-[var(--padding-row-y)] text-sm text-token-description-foreground">
                  {emptyLabel ?? "No options available"}
                </div>
              ) : (
                items.map((item) => (
                  <DropdownMenuPrimitive.Item
                    key={item.value}
                    onSelect={() => onSelect(item.value)}
                    {...(
                      selectedItemDataAttribute && item.value === selectedValue
                        ? { [selectedItemDataAttribute]: "true" }
                        : {}
                    )}
                    className={cn(
                      SELECTOR_MENU_ITEM_CLASS_NAME,
                    )}
                  >
                    <ToolbarMenuItem
                      label={item.label}
                      description={showDescriptions ? item.description : undefined}
                      selected={item.value === selectedValue}
                      icon={renderItemIcon?.(item.value)}
                      multiline={showDescriptions}
                    />
                  </DropdownMenuPrimitive.Item>
                ))
              )}
            </div>
          </div>
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}
