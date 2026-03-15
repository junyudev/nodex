import { useState } from "react";
import { ChevronsLeftRight, ChevronsRightLeft, Minus, MoreHorizontal, Plus } from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";
import {
  SELECTOR_MENU_CONTENT_CLASS_NAME,
  SELECTOR_MENU_DIVIDER_CLASS_NAME,
  SELECTOR_MENU_DIVIDER_WRAPPER_CLASS_NAME,
} from "../ui/selector-menu-chrome";
import {
  KANBAN_COLUMN_WIDTH_PRESETS,
  KANBAN_COLUMN_WIDTH_STEP,
  MAX_KANBAN_COLUMN_WIDTH,
  MIN_KANBAN_COLUMN_WIDTH,
  clampKanbanColumnWidth,
} from "../../lib/kanban-column-layout";
import { cn } from "../../lib/utils";

interface ColumnActionPopoverProps {
  columnName: string;
  collapsed: boolean;
  width: number;
  accentColor: string;
  alwaysVisible?: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  onWidthChange: (width: number) => void;
}

function StepperButton({
  "aria-label": ariaLabel,
  disabled,
  onClick,
  children,
}: {
  "aria-label": string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
        "text-token-description-foreground hover:bg-token-foreground/5 hover:text-token-foreground",
        "disabled:pointer-events-none disabled:opacity-40",
      )}
    >
      {children}
    </button>
  );
}

export function ColumnActionPopover({
  columnName,
  collapsed,
  width,
  accentColor,
  alwaysVisible = false,
  onCollapsedChange,
  onWidthChange,
}: ColumnActionPopoverProps) {
  const [open, setOpen] = useState(false);
  const canDecreaseWidth = width > MIN_KANBAN_COLUMN_WIDTH;
  const canIncreaseWidth = width < MAX_KANBAN_COLUMN_WIDTH;

  const handleWidthChange = (nextWidth: number) => {
    const normalized = clampKanbanColumnWidth(nextWidth);
    if (normalized === width) return;
    onWidthChange(normalized);
  };

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          aria-label={`More options for ${columnName}`}
          title={`More options for ${columnName}`}
          className={cn(
            "inline-flex h-6 w-6 items-center justify-center rounded-md outline-none",
            "text-token-description-foreground hover:bg-token-foreground/5 hover:text-token-foreground",
            "focus-visible:ring-2 focus-visible:ring-(--ring)/35",
            alwaysVisible
              ? "opacity-100"
              : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100",
          )}
          style={{ color: accentColor }}
          onClick={(event) => {
            event.stopPropagation();
          }}
        >
          <MoreHorizontal className="size-3.5" />
        </button>
      </PopoverPrimitive.Trigger>

      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          className={cn(SELECTOR_MENU_CONTENT_CLASS_NAME, "w-52 outline-none")}
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <div className="flex flex-col">
            {/* Header: accent bar + column name */}
            <div className="flex items-center gap-2 px-[var(--padding-row-x)] pt-[var(--padding-row-y)] pb-0.5">
              <div
                className="h-3 w-0.5 shrink-0 rounded-full"
                style={{ backgroundColor: accentColor }}
              />
              <span className="truncate text-sm font-medium text-token-foreground">
                {columnName}
              </span>
            </div>

            {/* Collapse / Expand action */}
            <button
              type="button"
              onClick={() => {
                onCollapsedChange(!collapsed);
                setOpen(false);
              }}
              className={cn(
                "mx-1 flex items-center gap-2 rounded-lg px-[var(--padding-row-x)] py-[var(--padding-row-y)] text-left text-sm",
                "text-token-foreground hover:bg-token-list-hover-background",
              )}
            >
              {collapsed ? (
                <ChevronsLeftRight className="size-3.5 shrink-0 text-token-description-foreground" />
              ) : (
                <ChevronsRightLeft className="size-3.5 shrink-0 text-token-description-foreground" />
              )}
              <span>{collapsed ? "Expand" : "Collapse"}</span>
            </button>

            <div className={SELECTOR_MENU_DIVIDER_WRAPPER_CLASS_NAME}>
              <div className={SELECTOR_MENU_DIVIDER_CLASS_NAME} />
            </div>

            {/* Width controls */}
            <div className="px-[var(--padding-row-x)] pt-0.5 pb-[var(--padding-row-y)]">
              <div className="flex items-center justify-between">
                <span className="text-xs text-token-description-foreground">Width</span>
                <span className="text-xs tabular-nums text-token-description-foreground">
                  {width}px
                </span>
              </div>

              {/* Stepper + presets row */}
              <div className="mt-1.5 flex items-center gap-0.5">
                <StepperButton
                  aria-label={`Decrease ${columnName} width`}
                  disabled={!canDecreaseWidth}
                  onClick={() => handleWidthChange(width - KANBAN_COLUMN_WIDTH_STEP)}
                >
                  <Minus className="size-3" />
                </StepperButton>

                <div className="flex flex-1 items-center justify-center gap-0.5">
                  {KANBAN_COLUMN_WIDTH_PRESETS.map((preset) => {
                    const isActive = width === preset.width;
                    return (
                      <button
                        key={preset.width}
                        type="button"
                        aria-pressed={isActive}
                        onClick={() => handleWidthChange(preset.width)}
                        className={cn(
                          "flex-1 rounded-md py-1 text-center text-xs font-medium",
                          isActive
                            ? "bg-token-foreground/10 text-token-foreground"
                            : "text-token-description-foreground hover:bg-token-foreground/5 hover:text-token-foreground",
                        )}
                      >
                        {preset.label}
                      </button>
                    );
                  })}
                </div>

                <StepperButton
                  aria-label={`Increase ${columnName} width`}
                  disabled={!canIncreaseWidth}
                  onClick={() => handleWidthChange(width + KANBAN_COLUMN_WIDTH_STEP)}
                >
                  <Plus className="size-3" />
                </StepperButton>
              </div>
            </div>
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
