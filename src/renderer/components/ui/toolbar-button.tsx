import { forwardRef, type ButtonHTMLAttributes } from "react";
import { ActivitySpinnerIcon } from "@/components/shared/icons";
import { EllipsisIcon } from "@/components/shared/icons/customize-action-icons";
import { cn } from "@/lib/utils";

export type ToolbarButtonColor = "ghost" | "ghostActive" | "primary" | "secondary" | "outline";

const TOOLBAR_BUTTON_BASE_CLASS =
  "no-drag inline-flex cursor-interaction items-center gap-1 border whitespace-nowrap select-none focus:outline-hidden focus-visible:ring-2 focus-visible:ring-token-focus-border disabled:cursor-default disabled:opacity-40 aria-disabled:cursor-default aria-disabled:opacity-40";

const TOOLBAR_BUTTON_COLOR_CLASS: Record<ToolbarButtonColor, string> = {
  ghost:
    "border-transparent text-tertiary not-disabled:not-aria-disabled:hover:bg-token-list-hover-background data-[state=open]:bg-token-list-hover-background",
  ghostActive:
    "border-transparent text-token-foreground not-disabled:not-aria-disabled:hover:bg-token-list-hover-background data-[state=open]:bg-token-list-hover-background",
  primary:
    "border-default bg-primary-solid text-primary-solid not-disabled:not-aria-disabled:hover:bg-text/80 data-[state=open]:bg-text/80",
  secondary:
    "border-transparent bg-text/5 text-token-foreground not-disabled:not-aria-disabled:hover:bg-text/10 data-[state=open]:bg-text/10",
  outline:
    "border-default bg-(--color-background-primary-soft-alpha) not-disabled:not-aria-disabled:hover:bg-token-list-hover-background data-[state=open]:bg-token-list-hover-background",
};

export interface ToolbarButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly color?: ToolbarButtonColor;
  /** Icon-only: a square as tall as the toolbar. */
  readonly uniform?: boolean;
  /** `icon`: a 24px square for inline row actions, such as removing a list entry. */
  readonly size?: "toolbar" | "icon";
  readonly loading?: boolean;
}

/**
 * A toolbar-height button: 32px inside a page header and 28px elsewhere, with 8px padding,
 * or a square when `uniform`.
 */
export const ToolbarButton = forwardRef<HTMLButtonElement, ToolbarButtonProps>(
  function ToolbarButton(
    {
      color = "ghost",
      uniform = false,
      size = "toolbar",
      loading = false,
      className,
      children,
      type,
      ...props
    },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type ?? "button"}
        aria-busy={loading || undefined}
        className={cn(
          TOOLBAR_BUTTON_BASE_CLASS,
          "rounded-(--radius-button-toolbar) py-0 text-sm leading-[18px]",
          size === "icon"
            ? "size-6 shrink-0 justify-center px-0"
            : uniform
              ? "h-token-button-composer w-token-button-composer justify-center px-0"
              : "h-token-button-composer px-2",
          TOOLBAR_BUTTON_COLOR_CLASS[color],
          className,
        )}
        {...props}
      >
        {loading ? <ActivitySpinnerIcon className="icon-sm" /> : children}
      </button>
    );
  },
);

/**
 * Where a "More actions" trigger sits: a directory row, a settings row, a sidebar row, or a
 * page toolbar beside other toolbar buttons.
 */
export type MoreActionsVariant = "card" | "settings" | "sidebar" | "toolbar";

const MORE_ACTIONS_VARIANT_CLASS: Record<MoreActionsVariant, string> = {
  // The toolbar-sized square on directory rows draws its dots in full text color.
  card: "size-token-button-composer rounded-lg text-token-foreground hover:bg-(--color-background-secondary-ghost-hover) aria-expanded:bg-(--color-background-secondary-ghost-hover)/60",
  settings:
    "size-7 rounded-[9.375px] text-(--color-text-secondary-ghost) hover:bg-(--color-background-secondary-ghost-hover) hover:text-(--color-text-secondary-ghost-hover) aria-expanded:bg-(--color-background-secondary-ghost-hover)/60",
  sidebar:
    "size-5 rounded-[9.375px] text-(--color-text-secondary-ghost) hover:text-(--color-text-secondary-ghost-hover) aria-expanded:text-(--color-text-secondary-ghost-hover)",
  toolbar:
    "size-token-button-composer rounded-full text-(--color-text-toolbar-action) hover:bg-(--color-background-secondary-ghost-hover) aria-expanded:bg-(--color-background-secondary-ghost-hover)",
};

export const MoreActionsButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { readonly variant: MoreActionsVariant }
>(function MoreActionsButton({ variant, className, type, ...props }, ref) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      aria-label="More actions"
      className={cn(
        "no-drag inline-flex shrink-0 cursor-interaction items-center justify-center outline-hidden focus-visible:ring-2 focus-visible:ring-token-focus-border disabled:opacity-40",
        MORE_ACTIONS_VARIANT_CLASS[variant],
        className,
      )}
      {...props}
    >
      <EllipsisIcon />
    </button>
  );
});
