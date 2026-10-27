import { useId, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { NodexTooltip } from "./tooltip";

export interface CardTileProps {
  /**
   * `row`: a compact list row with a 36px icon tile. `card`: a borderless 16px-radius card with a
   * 40px icon tile and a medium-weight title that tints on hover.
   */
  readonly presentation?: "row" | "card";
  readonly icon?: ReactNode;
  /** Frame the icon in a 36px tile; `false` places it bare. */
  readonly iconContainer?: boolean;
  readonly iconContainerVariant?: "filled" | "outline";
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly descriptionClassName?: string;
  /** Applied to the title and description column, e.g. to dim it. */
  readonly contentClassName?: string;
  readonly badges?: ReactNode;
  readonly actions?: ReactNode;
  /** Clicking or pressing Enter/Space on the row. */
  readonly onClick?: () => void;
  /** Keeps the row focusable for its tooltip but inert to clicks. */
  readonly disabled?: boolean;
  readonly tooltip?: ReactNode;
  /** Marks the keyboard-selected search result. */
  readonly isHighlighted?: boolean;
  readonly className?: string;
}

/**
 * An icon, a one-line title over a description, and trailing actions centered on the tile. A
 * clickable tile shows an inset focus ring and activates with Enter or Space.
 */
export function CardTile({
  presentation = "row",
  icon,
  iconContainer = true,
  iconContainerVariant = "filled",
  title,
  description,
  descriptionClassName,
  contentClassName,
  badges,
  actions,
  onClick,
  disabled = false,
  tooltip,
  isHighlighted = false,
  className,
}: CardTileProps) {
  const isRow = presentation === "row";
  const titleId = useId();
  const interactive = onClick != null && !disabled;
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.currentTarget.click();
  };

  const iconNode =
    icon == null ? null : iconContainer ? (
      <span
        className={cn(
          "flex shrink-0 items-center justify-center rounded-lg",
          isRow ? "size-9" : "size-10",
          iconContainerVariant === "outline"
            ? "border border-(--color-border) bg-transparent"
            : "bg-(--color-surface-secondary)",
        )}
      >
        {icon}
      </span>
    ) : (
      <span className="shrink-0">{icon}</span>
    );

  const row = (
    <div
      role={onClick != null || disabled ? "button" : undefined}
      tabIndex={onClick != null || disabled ? 0 : -1}
      aria-disabled={disabled || undefined}
      aria-labelledby={onClick != null || disabled ? titleId : undefined}
      data-search-result-active={isHighlighted ? "true" : undefined}
      className={cn(
        "flex flex-col justify-center gap-2.5",
        isRow
          ? "min-h-(--height-token-row) w-full min-w-0 rounded-(--radius-token-row) px-(--padding-row-x) py-(--padding-row-y)"
          : "rounded-2xl p-2 text-base select-none hover:bg-text/5",
        isHighlighted && "bg-text/5",
        interactive &&
          "cursor-interaction outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border focus-visible:ring-inset",
        interactive && isRow && "hover:bg-token-list-hover-background",
        disabled && "outline-none",
        className,
      )}
      onClick={interactive ? onClick : undefined}
      onKeyDown={interactive ? handleKeyDown : undefined}
    >
      <div className="flex items-center gap-3">
        {iconNode}
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div
            className={cn("flex min-w-0 flex-1 flex-col justify-center gap-0.5", contentClassName)}
          >
            <div className="flex min-w-0 items-center gap-2">
              <div
                id={titleId}
                className={cn(
                  "truncate text-token-foreground",
                  isRow ? "text-(length:--detail-row-font-size,var(--text-base))" : "font-medium",
                )}
              >
                {title}
              </div>
              {badges == null ? null : (
                <div className="flex shrink-0 items-center gap-1">{badges}</div>
              )}
            </div>
            {description == null || description === "" ? null : (
              <div
                className={cn(
                  "text-sm leading-relaxed text-(--color-text-secondary)",
                  descriptionClassName ?? "line-clamp-3",
                )}
              >
                {description}
              </div>
            )}
          </div>
          {actions == null ? null : <div className="flex shrink-0 items-center">{actions}</div>}
        </div>
      </div>
    </div>
  );

  return tooltip == null ? (
    row
  ) : (
    <NodexTooltip tooltipContent={tooltip} side="top">
      {row}
    </NodexTooltip>
  );
}
