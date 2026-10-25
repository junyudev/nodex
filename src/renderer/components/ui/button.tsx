import * as React from "react";
import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { NodexTooltip } from "./tooltip";

const nodexButtonVariants = cva(
  [
    "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap",
    "outline-hidden transition-colors disabled:pointer-events-none disabled:opacity-50",
    // A button that stays focusable while disabled is only marked disabled.
    "data-disabled:pointer-events-none data-disabled:opacity-50",
    "focus-visible:ring-token-focus-border focus-visible:ring-2",
    "cursor-interaction",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
    "[&_svg:not([class*='size-']):not([class*='icon-'])]:size-4",
  ],
  {
    variants: {
      variant: {
        default: "bg-primary-solid text-primary-solid hover:bg-text/80",
        primary: "bg-primary-solid text-primary-solid hover:bg-text/80",
        secondary: "bg-token-foreground/6 text-token-foreground hover:bg-token-foreground/10",
        outline:
          "border border-token-border bg-token-main-surface-primary text-token-foreground hover:bg-token-list-hover-background",
        ghost: "text-token-foreground hover:bg-token-list-hover-background",
        destructive: "bg-(--color-background-danger-surface) text-danger hover:opacity-90",
        accentAction:
          "border border-transparent bg-chart-blue text-(--app-color-text-on-accent) hover:bg-chart-blue/90",
      },
      size: {
        default: "h-9 rounded-xl px-4 text-sm",
        sm: "h-8 rounded-lg px-3 text-sm",
        xs: "h-6 rounded-md px-2 text-xs [&_svg:not([class*='size-']):not([class*='icon-'])]:size-3",
        composer: "h-token-button-composer rounded-lg px-2 py-0 text-base leading-[18px]",
        lg: "h-10 rounded-xl px-5 text-sm",
        icon: "size-9 rounded-xl",
        "icon-sm": "size-8 rounded-lg",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-']):not([class*='icon-'])]:size-3",
        "icon-lg": "size-10 rounded-xl",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface NodexButtonProps
  extends
    Omit<ButtonPrimitive.Props, "className" | "title">,
    VariantProps<typeof nodexButtonVariants> {
  className?: string;
}

export const NodexButton = React.forwardRef<HTMLButtonElement, NodexButtonProps>(
  function NodexButton({ className, variant, size, type, ...props }, ref) {
    return (
      <ButtonPrimitive
        ref={ref}
        data-slot="codex-button"
        type={type ?? (props.render ? undefined : "button")}
        className={cn(nodexButtonVariants({ variant, size, className }))}
        {...props}
      />
    );
  },
);

export interface NodexIconButtonProps extends React.ComponentProps<"button"> {
  icon: React.ComponentType<{ className?: string }>;
  active?: boolean;
  tone?: "default" | "danger";
  size?: "xs" | "sm" | "default";
  ariaLabel: string;
}

export const NodexIconButton = React.forwardRef<HTMLButtonElement, NodexIconButtonProps>(
  function NodexIconButton(
    {
      icon: Icon,
      active = false,
      tone = "default",
      size = "default",
      disabled = false,
      className,
      ariaLabel,
      type = "button",
      title,
      ...props
    },
    ref,
  ) {
    const tooltipText = title ?? ariaLabel;
    return (
      <NodexTooltip
        tooltipContent={<span className="whitespace-pre-line">{tooltipText}</span>}
        side="top"
      >
        <button
          ref={ref}
          {...props}
          type={type}
          disabled={disabled}
          aria-label={ariaLabel}
          data-active={active ? "true" : undefined}
          className={cn(
            "inline-flex items-center justify-center rounded-md outline-hidden",
            "focus-visible:ring-token-focus-border focus-visible:ring-2",
            size === "xs" && "size-6",
            size === "sm" && "size-7",
            size === "default" && "size-8",
            tone === "danger"
              ? active
                ? "text-danger hover:bg-text-danger/10"
                : "text-danger/70 hover:bg-text-danger/10 hover:text-(--color-text-danger)"
              : active
                ? "text-info hover:bg-text-info/12"
                : "text-[color-mix(in_srgb,var(--foreground)_62%,transparent)] hover:bg-[color-mix(in_srgb,var(--foreground)_5%,transparent)] hover:text-(--foreground)",
            disabled && "cursor-not-allowed opacity-40 hover:bg-transparent",
            className,
          )}
        >
          <Icon className="size-4" />
        </button>
      </NodexTooltip>
    );
  },
);

export interface NodexSwitchProps {
  ariaLabel?: string;
  checked: boolean;
  className?: string;
  disabled?: boolean;
  size?: "default" | "compact";
  onCheckedChange: (nextChecked: boolean) => void;
}

export function NodexSwitch({
  ariaLabel,
  checked,
  className,
  disabled = false,
  size = "default",
  onCheckedChange,
}: NodexSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={ariaLabel}
      aria-checked={checked}
      data-state={checked ? "checked" : "unchecked"}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "inline-flex items-center text-sm outline-hidden",
        "focus-visible:rounded-full focus-visible:ring-token-focus-border focus-visible:ring-2",
        disabled ? "cursor-not-allowed opacity-60" : "cursor-interaction",
        className,
      )}
    >
      <span
        className={cn(
          "relative inline-flex shrink-0 items-center rounded-full transition-colors duration-200 ease-out",
          size === "compact" ? "h-3.5 w-[22px]" : "h-5 w-8",
          checked ? "bg-chart-blue" : "bg-text/10",
        )}
        data-state={checked ? "checked" : "unchecked"}
      >
        <span
          className={cn(
            "rounded-full border border-control-thumb-on-accent bg-control-thumb-on-accent shadow-sm transition-transform duration-200 ease-out",
            size === "compact" ? "size-3" : "size-4",
            checked
              ? size === "compact"
                ? "translate-x-[9px]"
                : "translate-x-[14px]"
              : size === "compact"
                ? "translate-x-px"
                : "translate-x-[2px]",
          )}
          data-state={checked ? "checked" : "unchecked"}
        />
      </span>
    </button>
  );
}
