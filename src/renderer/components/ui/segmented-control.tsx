import type { ComponentType } from "react";
import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly icon?: ComponentType<{ className?: string }>;
}

/**
 * A few mutually exclusive values chosen in place: quiet pills, with the chosen one tinted. `sm`
 * sits in a toolbar or list header; the default suits a Settings row.
 */
export function NodexSegmentedControl<T extends string>({
  ariaLabel,
  value,
  onChange,
  options,
  size = "md",
  disabled = false,
}: {
  readonly ariaLabel: string;
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly options: readonly SegmentedOption<T>[];
  readonly size?: "sm" | "md";
  readonly disabled?: boolean;
}) {
  return (
    <div
      className="inline-flex max-w-full flex-wrap items-center gap-0.5"
      role="group"
      aria-label={ariaLabel}
    >
      {options.map((option) => {
        const Icon = option.icon;
        const isActive = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(option.value)}
            aria-pressed={isActive}
            className={cn(
              "flex items-center gap-1 rounded-full border border-transparent px-2 py-0.5",
              size === "sm" ? "text-xs/4" : "text-sm/4.5",
              "outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border/30 disabled:opacity-50",
              isActive
                ? "bg-foreground-5 text-(--foreground)"
                : "text-(--foreground-secondary) not-disabled:hover:bg-foreground-5",
            )}
          >
            {Icon ? <Icon className={size === "sm" ? "size-3.5" : "size-4"} /> : null}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
