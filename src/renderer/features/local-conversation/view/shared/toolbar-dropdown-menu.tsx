import { useIntl } from "@/lib/i18n";
import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { cn } from "../../../../lib/utils";
import { CheckmarkIcon, ChevronDownIcon } from "@/components/shared/icons";
import {
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownMessage,
  NodexDropdownSection,
  NodexDropdownTitle,
} from "@/components/ui/dropdown";

const ToolbarDropdown = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<"button"> & {
    label: ReactNode;
    ariaLabel?: string;
  }
>(function ToolbarDropdown({ label, className, ariaLabel, type = "button", ...props }, ref) {
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
      <span className="min-w-0">{label}</span>
      <ChevronDownIcon />
    </button>
  );
});

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
  label: ReactNode;
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
  const intl = useIntl();
  return (
    <NodexDropdownMenu
      triggerButton={<ToolbarDropdown label={label} className={className} ariaLabel={ariaLabel} />}
      side="top"
      align="start"
      contentClassName="max-h-[min(20rem,var(--nodex-floating-surface-available-height,20rem))]"
    >
      <NodexDropdownSection className="flex min-w-40 flex-col overflow-hidden pt-1">
        <NodexDropdownTitle>{title}</NodexDropdownTitle>
        <div className="flex max-h-[250px] flex-col overflow-y-auto">
          {items.length === 0 ? (
            <NodexDropdownMessage compact>
              {emptyLabel ??
                intl.formatMessage({
                  id: "conversation.toolbarDropdownMenu.noOptions",
                  defaultMessage: "No options available",
                })}
            </NodexDropdownMessage>
          ) : (
            items.map((item) => {
              const icon = renderItemIcon?.(item.value);

              return (
                <NodexDropdownItem
                  key={item.value}
                  onSelect={() => onSelect(item.value)}
                  {...(selectedItemDataAttribute && item.value === selectedValue
                    ? { [selectedItemDataAttribute]: "true" }
                    : {})}
                  leftSlot={icon ? <span className="text-token-foreground">{icon}</span> : null}
                  rightSlot={
                    item.value === selectedValue ? (
                      <CheckmarkIcon className="shrink-0 text-token-foreground" />
                    ) : null
                  }
                  subText={showDescriptions ? item.description : undefined}
                  allowWrap={showDescriptions}
                >
                  {item.label}
                </NodexDropdownItem>
              );
            })
          )}
        </div>
      </NodexDropdownSection>
    </NodexDropdownMenu>
  );
}
