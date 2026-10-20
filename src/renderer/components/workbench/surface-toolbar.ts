import { cn } from "@/lib/utils";

/**
 * The row that tops a tab's surface, the full width of the tab: its views as pills at the start
 * and its tools at the end, so every tab keeps them in the same place.
 */
export const SURFACE_TOOLBAR_ROW_CLASS = "flex h-10 items-center gap-2 pl-4 pr-2";

/** One of a surface's views, shown as a pill; the active one is filled. */
export const surfaceViewPillClassName = ({
  active,
  menuOpen = false,
}: {
  readonly active: boolean;
  /** The active view's menu is open, so it reads as pressed. */
  readonly menuOpen?: boolean;
}) =>
  cn(
    "group/view inline-flex h-8 max-w-[220px] shrink-0 items-center justify-center rounded-[20px]",
    "px-3 text-sm font-medium leading-[16.8px] whitespace-nowrap outline-none",
    "focus-visible:ring-2 focus-visible:ring-(--ring)/35",
    active
      ? menuOpen
        ? "bg-token-foreground/10 text-token-text-primary"
        : "bg-token-foreground/5 text-token-text-primary"
      : "text-token-text-secondary hover:bg-token-foreground/5 hover:text-token-text-primary",
  );
