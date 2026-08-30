import type { ReactNode } from "react";

import {
  NodexDropdownButtonTrigger,
  NodexOptionPicker,
  NodexSettingsDropdownTrigger,
  type NodexOptionPickerSearchMode,
  type NodexDropdownButtonTriggerProps,
  type NodexDropdownContentWidth,
} from "@/components/ui/dropdown";
import { cn } from "@/lib/utils";

export interface DatabaseViewSelectOption {
  readonly value: string;
  readonly label: ReactNode;
  readonly searchText?: string;
  readonly disabled?: boolean;
}

interface DatabaseViewSelectProps {
  readonly ariaLabel: string;
  readonly value: string;
  readonly valueLabel: ReactNode;
  readonly options: readonly DatabaseViewSelectOption[];
  readonly onValueChange: (value: string) => void;
  readonly disabled?: boolean;
  readonly search?: NodexOptionPickerSearchMode;
  readonly searchPlaceholder?: string;
  readonly className?: string;
  readonly contentWidth?: NodexDropdownContentWidth;
  readonly align?: "start" | "center" | "end";
  readonly chrome?: NodexDropdownButtonTriggerProps["chrome"];
  readonly size?: NodexDropdownButtonTriggerProps["size"];
  readonly showChevron?: boolean;
  readonly triggerStyle?: "default" | "settings";
  /** Controls the trigger itself; popup sizing remains owned by `contentWidth`. */
  readonly triggerWidth?: "content" | "fill";
}

export function DatabaseViewSelect({
  ariaLabel,
  value,
  valueLabel,
  options,
  onValueChange,
  disabled = false,
  search = "none",
  searchPlaceholder,
  className,
  contentWidth = "sm",
  align = "end",
  chrome,
  size = "xs",
  showChevron = true,
  triggerStyle = "default",
  triggerWidth,
}: DatabaseViewSelectProps) {
  const triggerContent = (
    <span
      className={cn(
        "min-w-0 truncate text-left",
        triggerWidth === "content" ? "flex-initial" : "flex-1",
      )}
    >
      {valueLabel}
    </span>
  );
  const triggerWidthClassName =
    triggerWidth === "content"
      ? "w-fit max-w-[180px]"
      : triggerWidth === "fill"
        ? "w-full"
        : undefined;

  return (
    <NodexOptionPicker
      value={value}
      disabled={disabled}
      search={search}
      searchPlaceholder={searchPlaceholder}
      searchAriaLabel={search === "filter" ? `Search ${ariaLabel}` : undefined}
      onValueChange={onValueChange}
      contentWidth={contentWidth}
      align={align}
      options={options.map((option) => ({
        value: option.value,
        label: option.label,
        searchText: option.searchText,
        disabled: option.disabled,
      }))}
      triggerButton={
        triggerStyle === "settings" ? (
          <NodexSettingsDropdownTrigger
            aria-label={ariaLabel}
            aria-disabled={disabled}
            className={cn("min-w-0", triggerWidthClassName, className)}
          >
            {triggerContent}
          </NodexSettingsDropdownTrigger>
        ) : (
          <NodexDropdownButtonTrigger
            aria-label={ariaLabel}
            aria-disabled={disabled}
            size={size}
            chrome={chrome}
            showChevron={showChevron}
            className={cn("min-w-0", triggerWidthClassName, className)}
          >
            {triggerContent}
          </NodexDropdownButtonTrigger>
        )
      }
    />
  );
}
