import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { cn } from "../../../../lib/utils";
import { NodexTooltip } from "@/components/ui/tooltip";

interface ThreadSummaryPanelRowProps extends Omit<
  ComponentPropsWithoutRef<"div">,
  "children" | "onClick" | "onPointerDown" | "title"
> {
  label: ReactNode;
  icon?: ReactNode;
  accessory?: ReactNode;
  actions?: ReactNode;
  actionsAlwaysFocusable?: boolean;
  actionsVisible?: boolean;
  trailing?: ReactNode;
  trailingVisible?: boolean;
  density?: "compact" | "comfortable";
  title?: string;
  disabled?: boolean;
  interactive?: boolean;
  labelClassName?: string;
  className?: string;
  onClick?: (event: MouseEvent<HTMLDivElement>) => void;
  onPointerDown?: (event: MouseEvent<HTMLDivElement>) => void;
}

function stopRowPropagation(event: MouseEvent<HTMLSpanElement>) {
  event.stopPropagation();
}

export const ThreadSummaryPanelRow = forwardRef<HTMLDivElement, ThreadSummaryPanelRowProps>(
  function ThreadSummaryPanelRow(
    {
      label,
      icon,
      accessory,
      actions,
      actionsAlwaysFocusable = false,
      actionsVisible = false,
      trailing,
      trailingVisible = false,
      density = "compact",
      title,
      disabled = false,
      interactive,
      labelClassName,
      className,
      onClick,
      onPointerDown,
      onKeyDown,
      ...props
    },
    ref,
  ) {
    const hasInteractionHandler = Boolean(onClick || onPointerDown || onKeyDown);
    const isActionable = !disabled && hasInteractionHandler;
    const isVisuallyInteractive = !disabled && Boolean(interactive || hasInteractionHandler);

    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
      if (disabled) return;
      onKeyDown?.(event);
      if (event.defaultPrevented) return;
      if (!isActionable || !onClick) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.currentTarget.click();
    };

    const labelContent = (
      <span className={cn("text-sm", labelClassName ?? "truncate")}>{label}</span>
    );

    const accessoryContent = accessory ? (
      <span className="shrink-0 leading-none" onClick={stopRowPropagation}>
        {accessory}
      </span>
    ) : null;

    const actionsContent = actions ? (
      <span
        className={cn(
          "shrink-0 items-center",
          (actionsVisible || !actionsAlwaysFocusable) && "ms-auto",
          actionsVisible
            ? "flex"
            : actionsAlwaysFocusable
              ? "pointer-events-none absolute inset-y-0 end-0 flex opacity-0 group-focus-within/summary-panel-row:pointer-events-auto group-focus-within/summary-panel-row:opacity-100 group-hover/summary-panel-row:pointer-events-auto group-hover/summary-panel-row:opacity-100"
              : "hidden group-focus-within/summary-panel-row:flex group-hover/summary-panel-row:flex",
        )}
        onClick={stopRowPropagation}
        onKeyDown={(event) => {
          event.stopPropagation();
        }}
      >
        {actions}
      </span>
    ) : null;

    const trailingContent = trailing ? (
      <span
        className={cn(
          "shrink-0 leading-none opacity-0 group-focus-visible/summary-panel-row:opacity-100 group-focus-within/summary-panel-row:opacity-100 group-hover/summary-panel-row:opacity-100",
          (!actions || !actionsVisible || trailingVisible) && "ms-auto",
          actions &&
            !actionsVisible &&
            "group-focus-within/summary-panel-row:ms-0 group-hover/summary-panel-row:ms-0",
          trailingVisible && "opacity-100",
        )}
      >
        {trailing}
      </span>
    ) : null;

    const rowContent = (
      <>
        {icon ? (
          <span className="me-2 flex w-[18px] shrink-0 items-center justify-center">{icon}</span>
        ) : null}
        <span className="flex min-w-0 flex-1 items-center gap-2">
          {labelContent}
          {accessoryContent}
          {actionsContent}
          {trailingContent}
        </span>
      </>
    );

    const rowClassName = cn(
      "group/summary-panel-row relative isolate flex w-full min-w-0 items-center gap-1 rounded-sm border-0 bg-transparent px-0 text-start",
      density === "comfortable" ? "min-h-8 py-1.5" : "min-h-7 py-1",
      isVisuallyInteractive
        ? "cursor-interaction text-token-foreground before:absolute before:inset-y-0 before:-inset-x-2 before:-z-10 before:rounded-sm before:content-[''] hover:before:bg-token-list-hover-background"
        : disabled
          ? "cursor-not-allowed text-token-text-tertiary"
          : "cursor-default text-token-text-secondary",
      isActionable &&
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
      className,
    );

    return (
      <NodexTooltip
        tooltipContent={title ? <span className="whitespace-pre-line">{title}</span> : undefined}
      >
        <div
          {...props}
          ref={ref}
          role={hasInteractionHandler ? "button" : undefined}
          tabIndex={isActionable ? 0 : undefined}
          aria-disabled={disabled || undefined}
          className={rowClassName}
          onClick={isActionable && onClick ? onClick : undefined}
          onKeyDown={handleKeyDown}
          onPointerDown={isActionable ? onPointerDown : undefined}
        >
          {rowContent}
        </div>
      </NodexTooltip>
    );
  },
);
