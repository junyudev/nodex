import { ProjectActionsIcon, PlusIcon } from "@/components/shared/icons";
import { useState } from "react";
import {
  ChevronsLeftRight,
  ChevronsRightLeft,
  Minus,
} from "@/components/shared/icons/generic-icons";
import { NodexDropdownSeparator } from "@/components/ui/dropdown";
import { NodexPopover, NodexPopoverContent, NodexPopoverTrigger } from "@/components/ui/popover";
import { NodexTooltip } from "@/components/ui/tooltip";
import {
  BOARD_COLUMN_WIDTH_PRESETS,
  BOARD_COLUMN_WIDTH_STEP,
  MAX_BOARD_COLUMN_WIDTH,
  MIN_BOARD_COLUMN_WIDTH,
  clampBoardColumnWidth,
} from "../../lib/board-column-layout";
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

interface ColumnActionPopoverContentProps {
  columnName: string;
  collapsed: boolean;
  width: number;
  onCollapsedChange: (collapsed: boolean) => void;
  onWidthChange: (width: number) => void;
  onRequestClose: () => void;
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
        "inline-flex h-full min-w-0 items-center justify-center rounded-[6px]",
        "text-token-description-foreground hover:bg-token-foreground/5 hover:text-token-foreground",
        "disabled:pointer-events-none disabled:opacity-40",
      )}
    >
      {children}
    </button>
  );
}

export function ColumnActionPopoverContent({
  columnName,
  collapsed,
  width,
  onCollapsedChange,
  onWidthChange,
  onRequestClose,
}: ColumnActionPopoverContentProps) {
  const canDecreaseWidth = width > MIN_BOARD_COLUMN_WIDTH;
  const canIncreaseWidth = width < MAX_BOARD_COLUMN_WIDTH;

  const handleWidthChange = (nextWidth: number) => {
    const normalized = clampBoardColumnWidth(nextWidth);
    if (normalized === width) return;
    onWidthChange(normalized);
  };

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => {
          onCollapsedChange(!collapsed);
          onRequestClose();
        }}
        className={cn(
          "flex min-h-8 items-center gap-2 rounded-lg px-[var(--padding-row-x)] py-[var(--padding-row-y)] text-left text-sm",
          "text-token-foreground hover:bg-token-list-hover-background",
        )}
      >
        {collapsed ? (
          <ChevronsLeftRight className="icon-xs shrink-0 text-token-text-secondary" />
        ) : (
          <ChevronsRightLeft className="icon-xs shrink-0 text-token-text-secondary" />
        )}
        <span>{collapsed ? "Expand column" : "Collapse column"}</span>
      </button>

      <NodexDropdownSeparator />

      <div className="px-2 py-2">
        <div className="flex items-baseline justify-between gap-3 px-0.5">
          <span className="truncate text-xs font-medium text-token-text-secondary">
            Column width
          </span>
          <output className="shrink-0 text-xs tabular-nums text-token-description-foreground">
            {width}px
          </output>
        </div>

        <div
          role="group"
          aria-label={`${columnName} column width`}
          className="mt-1.5 grid h-8 grid-cols-[28px_repeat(3,minmax(0,1fr))_28px] items-stretch rounded-lg bg-token-foreground/5 p-0.5 ring-[0.5px] ring-inset ring-token-border"
        >
          <StepperButton
            aria-label={`Decrease ${columnName} width`}
            disabled={!canDecreaseWidth}
            onClick={() => handleWidthChange(width - BOARD_COLUMN_WIDTH_STEP)}
          >
            <Minus className="size-3" />
          </StepperButton>

          {BOARD_COLUMN_WIDTH_PRESETS.map((preset) => {
            const isActive = width === preset.width;
            return (
              <button
                key={preset.width}
                type="button"
                aria-pressed={isActive}
                onClick={() => handleWidthChange(preset.width)}
                className={cn(
                  "min-w-0 truncate rounded-[6px] px-0.5 text-[11px] leading-none font-medium",
                  isActive
                    ? "bg-token-foreground/10 text-token-foreground"
                    : "text-token-description-foreground hover:bg-token-foreground/5 hover:text-token-foreground",
                )}
              >
                {preset.label}
              </button>
            );
          })}

          <StepperButton
            aria-label={`Increase ${columnName} width`}
            disabled={!canIncreaseWidth}
            onClick={() => handleWidthChange(width + BOARD_COLUMN_WIDTH_STEP)}
          >
            <PlusIcon className="size-3" />
          </StepperButton>
        </div>
      </div>
    </div>
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

  return (
    <NodexPopover open={open} onOpenChange={setOpen}>
      <NodexTooltip tooltipContent={`More options for ${columnName}`} side="bottom">
        <NodexPopoverTrigger>
          <button
            type="button"
            aria-label={`More options for ${columnName}`}
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
            <ProjectActionsIcon className="size-3.5" />
          </button>
        </NodexPopoverTrigger>
      </NodexTooltip>

      <NodexPopoverContent side="bottom" align="end" className="w-56" initialFocus={false}>
        <ColumnActionPopoverContent
          columnName={columnName}
          collapsed={collapsed}
          width={width}
          onCollapsedChange={onCollapsedChange}
          onWidthChange={onWidthChange}
          onRequestClose={() => setOpen(false)}
        />
      </NodexPopoverContent>
    </NodexPopover>
  );
}
