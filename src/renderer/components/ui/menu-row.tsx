import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Box and type of every menu row, shared by Dropdown and ContextMenu owners. */
export const nodexMenuRowClassName =
  "no-drag rounded-lg px-[var(--padding-row-x)] py-[var(--padding-row-y)] text-sm text-token-foreground outline-hidden";

/**
 * The inside of every menu row: an optional leading visual, the label, then trailing content.
 * Items, submenu triggers, radio and option rows all compose it, so one gap separates each
 * leading visual from its label and labels line up down a menu whatever kind each row is.
 */
export function NodexMenuRowContent({
  leading,
  trailing,
  children,
  wrap = false,
  alignStart = false,
  highlight = true,
  tone = "default",
  labelClassName,
}: {
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
  readonly children: ReactNode;
  readonly wrap?: boolean;
  readonly alignStart?: boolean;
  /** The leading visual brightens with its highlighted row; disabled rows stay muted. */
  readonly highlight?: boolean;
  readonly tone?: "default" | "danger";
  readonly labelClassName?: string;
}) {
  return (
    <span className={cn("flex w-full min-w-0 items-center gap-2", alignStart && "items-start")}>
      {leading ? (
        <span
          className={cn(
            "inline-flex shrink-0 items-center justify-center [&_svg]:size-4 [&_svg]:shrink-0",
            tone === "danger"
              ? "text-token-error-foreground"
              : cn(
                  "text-token-text-secondary",
                  highlight &&
                    "group-hover:text-token-foreground group-focus:text-token-foreground group-data-[highlighted]:text-token-foreground",
                ),
          )}
        >
          {leading}
        </span>
      ) : null}
      <span
        className={cn(
          "min-w-0 flex-1 text-start",
          wrap ? "whitespace-normal" : "truncate",
          labelClassName,
        )}
      >
        {children}
      </span>
      {trailing}
    </span>
  );
}
