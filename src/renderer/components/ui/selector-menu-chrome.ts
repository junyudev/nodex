import { cn } from "@/lib/utils";

const SELECTOR_MENU_CONTENT_SURFACE_CLASS_NAME = cn(
  "no-drag bg-token-dropdown-background/90 text-token-foreground ring-token-border z-50 m-px flex select-none flex-col overflow-y-auto rounded-xl ring-[0.5px] px-1 py-1 shadow-lg backdrop-blur-sm",
  "[will-change:opacity,transform]",
  "[--dropdown-scale:0.985] [--dropdown-translate:0.375rem]",
);

const SELECTOR_MENU_CONTENT_MOTION_CLASS_NAME = cn(
  "[--dropdown-entry-transform:translateY(calc(var(--dropdown-translate)_*_-1))_scale(var(--dropdown-scale))]",
  "data-[side=top]:[--dropdown-entry-transform:translateY(calc(var(--dropdown-translate)_*_1))_scale(var(--dropdown-scale))]",
  "data-[side=right]:[--dropdown-entry-transform:translateX(calc(var(--dropdown-translate)_*_-1))_scale(var(--dropdown-scale))]",
  "data-[side=left]:[--dropdown-entry-transform:translateX(calc(var(--dropdown-translate)_*_1))_scale(var(--dropdown-scale))]",
  "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[var(--dropdown-scale)] data-[side=bottom]:data-[state=open]:slide-in-from-top-[var(--dropdown-translate)] data-[side=left]:data-[state=open]:slide-in-from-right-[var(--dropdown-translate)] data-[side=right]:data-[state=open]:slide-in-from-left-[var(--dropdown-translate)] data-[side=top]:data-[state=open]:slide-in-from-bottom-[var(--dropdown-translate)]",
  "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[var(--dropdown-scale)]",
);

export const SELECTOR_MENU_CONTENT_CLASS_NAME = cn(
  SELECTOR_MENU_CONTENT_SURFACE_CLASS_NAME,
  SELECTOR_MENU_CONTENT_MOTION_CLASS_NAME,
  "[transform-origin:var(--radix-dropdown-menu-content-transform-origin,var(--radix-popover-content-transform-origin))]",
);

export const SELECTOR_MENU_MATCH_TRIGGER_WIDTH_CLASS_NAME =
  "min-w-(--radix-select-trigger-width)";

export const SELECTOR_MENU_SELECT_CONTENT_CLASS_NAME = cn(
  SELECTOR_MENU_CONTENT_SURFACE_CLASS_NAME,
  SELECTOR_MENU_CONTENT_MOTION_CLASS_NAME,
  "relative max-h-[min(20rem,var(--radix-select-content-available-height,20rem))] overflow-x-hidden outline-none",
  SELECTOR_MENU_MATCH_TRIGGER_WIDTH_CLASS_NAME,
  "[transform-origin:var(--radix-select-content-transform-origin)]",
);

export const SELECTOR_MENU_SELECT_VIEWPORT_CLASS_NAME = "w-full scroll-my-1";

export const SELECTOR_MENU_PANEL_CLASS_NAME = "flex w-fit flex-col overflow-hidden pt-1";
export const SELECTOR_MENU_TITLE_CLASS_NAME =
  "text-token-description-foreground truncate px-[var(--padding-row-x)] py-[var(--padding-row-y)] text-sm";
export const SELECTOR_MENU_LIST_CLASS_NAME = "flex max-h-[250px] flex-col overflow-y-auto";
export const SELECTOR_MENU_ITEM_CLASS_NAME = cn(
  "no-drag text-token-foreground outline-hidden rounded-lg px-[var(--padding-row-x)] py-[var(--padding-row-y)] text-sm",
  "hover:bg-token-list-hover-background focus-visible:bg-token-list-hover-background data-highlighted:bg-token-list-hover-background",
  "cursor-interaction flex w-full data-disabled:pointer-events-none data-disabled:opacity-50",
);
export const SELECTOR_MENU_ITEM_INDICATOR_CLASS_NAME =
  "col-start-2 row-start-1 flex size-4 items-center justify-center text-token-foreground";
export const SELECTOR_MENU_LABEL_CLASS_NAME =
  "text-token-description-foreground px-[var(--padding-row-x)] py-[var(--padding-row-y)] text-sm";
export const SELECTOR_MENU_SEPARATOR_CLASS_NAME =
  "pointer-events-none mx-[var(--padding-row-x)] my-1 h-px bg-token-border";
export const SELECTOR_MENU_SCROLL_BUTTON_CLASS_NAME =
  "flex cursor-default items-center justify-center py-1 text-token-description-foreground";
export const SELECTOR_MENU_DIVIDER_WRAPPER_CLASS_NAME = "w-full px-[var(--padding-row-x)] py-1";
export const SELECTOR_MENU_DIVIDER_CLASS_NAME = "bg-token-border h-px w-full";
