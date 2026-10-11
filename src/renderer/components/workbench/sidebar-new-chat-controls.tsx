import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import {
  InboxIcon,
  NewChatIcon,
  SettingsSearchIcon,
  TitlebarNewChatIcon,
} from "@/components/shared/icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import { ShortcutKeycaps } from "@/components/ui/shortcut-keycaps";
import { cn } from "@/lib/utils";

export const SIDEBAR_NEW_CHAT_ROW_CLASS =
  "focus-visible:outline-token-border relative h-[var(--height-token-nav-row)] px-row-x py-row-y cursor-interaction shrink-0 items-center overflow-hidden rounded-lg text-left text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 gap-2 flex w-full hover:bg-token-list-hover-background group";
export const SIDEBAR_PROJECT_NEW_CHAT_BUTTON_CLASS =
  "border-token-border no-drag cursor-interaction flex items-center gap-1 border whitespace-nowrap select-none focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 rounded-full electron:rounded-md text-token-muted-foreground enabled:hover:bg-transparent data-[state=open]:bg-transparent hover:text-token-foreground border-transparent electron:p-1 electron:[&>svg]:icon-sm flex items-center justify-center p-0.5 h-6 w-6 rounded-md !p-1";
export const SIDEBAR_COLLAPSED_CHROME_BUTTON_CLASS =
  "border-token-border no-drag cursor-interaction flex items-center gap-1 border whitespace-nowrap select-none focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 rounded-lg h-token-button-composer px-2 py-0 text-base leading-[18px] aspect-square justify-center !px-0 text-token-text-tertiary enabled:hover:bg-token-list-hover-background data-[state=open]:bg-token-list-hover-background border-transparent";
export const SIDEBAR_SCROLL_AREA_CLASS =
  "sidebar-scroll-fade-mask relative isolate flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto -mt-[var(--sidebar-scroll-header-spacing,8px)] pt-[var(--sidebar-scroll-content-top-padding,var(--sidebar-scroll-header-spacing,8px))] [contain:layout_paint]";

const SIDEBAR_HEADER_SEARCH_BUTTON_CLASS =
  "border-token-border no-drag cursor-interaction ml-auto flex items-center justify-center gap-1 whitespace-nowrap rounded-md border border-transparent p-1 text-token-foreground select-none focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 enabled:hover:bg-token-list-hover-background data-[state=open]:bg-token-list-hover-background";

interface SidebarScrollChromeState {
  scrolledContentUnderHeader: boolean;
  hasContentBelow: boolean;
}

const INITIAL_SIDEBAR_SCROLL_CHROME_STATE: SidebarScrollChromeState = {
  scrolledContentUnderHeader: false,
  hasContentBelow: false,
};

function getSidebarScrollChromeStyle({
  scrolledContentUnderHeader,
  hasContentBelow,
}: SidebarScrollChromeState): CSSProperties {
  return {
    "--sidebar-footer-height": "0px",
    "--sidebar-scroll-footer-edge-offset": hasContentBelow ? "0px" : "calc(var(--spacing) * 10)",
    "--sidebar-scroll-content-top-padding": "1px",
    "--sidebar-scroll-header-fade-distance": scrolledContentUnderHeader
      ? "calc(var(--spacing) * 4)"
      : "1px",
    "--sidebar-scroll-header-fade-start": scrolledContentUnderHeader ? "var(--spacing)" : "0px",
    "--sidebar-scroll-header-spacing": scrolledContentUnderHeader ? "var(--spacing)" : "1px",
  } as CSSProperties;
}

export function useSidebarScrollChrome() {
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState(INITIAL_SIDEBAR_SCROLL_CHROME_STATE);

  const syncScrollChrome = useCallback(() => {
    const scrollArea = scrollAreaRef.current;
    if (!scrollArea) return;

    const nextState = {
      scrolledContentUnderHeader: scrollArea.scrollTop > 0,
      hasContentBelow: scrollArea.scrollHeight - scrollArea.clientHeight - scrollArea.scrollTop > 1,
    };
    setState((currentState) =>
      currentState.scrolledContentUnderHeader === nextState.scrolledContentUnderHeader &&
      currentState.hasContentBelow === nextState.hasContentBelow
        ? currentState
        : nextState,
    );
  }, []);

  useLayoutEffect(() => {
    const scrollArea = scrollAreaRef.current;
    if (!scrollArea) return undefined;

    syncScrollChrome();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", syncScrollChrome);
      return () => window.removeEventListener("resize", syncScrollChrome);
    }

    const resizeObserver = new ResizeObserver(syncScrollChrome);
    resizeObserver.observe(scrollArea);
    Array.from(scrollArea.children).forEach((child) => resizeObserver.observe(child));
    return () => resizeObserver.disconnect();
  }, [syncScrollChrome]);

  return {
    scrollAreaRef,
    scrollChromeStyle: getSidebarScrollChromeStyle(state),
    scrolledContentUnderHeader: state.scrolledContentUnderHeader,
    hasContentBelow: state.hasContentBelow,
    syncScrollChrome,
  };
}

export interface SidebarInboxEntry {
  readonly active: boolean;
  readonly count: number;
  readonly shortcutLabel: string;
  readonly onOpen: () => void;
}

export function SidebarExpandedHeader({
  productName,
  productStatusLabel,
  searchShortcutLabel,
  newChatShortcutLabel,
  scrolledContentUnderHeader,
  onSearch,
  onNewChat,
  inbox,
}: {
  productName: string;
  productStatusLabel?: string;
  searchShortcutLabel: string;
  newChatShortcutLabel: string;
  scrolledContentUnderHeader: boolean;
  onSearch: () => void;
  onNewChat: () => void;
  inbox?: SidebarInboxEntry;
}) {
  return (
    <div
      data-app-action-sidebar-scroll-header=""
      data-scrolled-content-under-header={scrolledContentUnderHeader}
      className={cn(
        "relative z-10 flex shrink-0 flex-col gap-2 px-row-x pb-[var(--sidebar-scroll-header-spacing)]",
        scrolledContentUnderHeader &&
          "after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-[0.5px] after:bg-token-foreground/10 after:content-['']",
      )}
    >
      <div className="ml-2 flex items-center">
        <div className="-ml-2 flex h-8 min-w-0 items-center gap-1.5 rounded-xl border border-transparent px-2 text-base leading-6 font-medium select-none">
          <span className="min-w-0 truncate font-semibold text-token-foreground">
            {productName}
          </span>
          {productStatusLabel ? (
            <span className="inline-flex h-4.5 shrink-0 items-center rounded-sm bg-token-foreground/5 px-1.5 text-xs font-medium leading-none text-token-description-foreground">
              {productStatusLabel}
            </span>
          ) : null}
        </div>
        <NodexTooltip tooltipContent="Search" shortcutLabel={searchShortcutLabel} side="right">
          <button
            type="button"
            className={SIDEBAR_HEADER_SEARCH_BUTTON_CLASS}
            aria-label="Search"
            onClick={onSearch}
          >
            <SettingsSearchIcon className="icon-xs" />
          </button>
        </NodexTooltip>
      </div>
      <div className="flex flex-col gap-px">
        {inbox ? <SidebarInboxButton entry={inbox} /> : null}
        <SidebarNewChatButton shortcutLabel={newChatShortcutLabel} onClick={onNewChat} />
      </div>
    </div>
  );
}

/**
 * The Inbox is the first place a new intention goes, so it sits above New chat. Its count is
 * the messages still in the Inbox; handling them brings it to zero.
 */
export function SidebarInboxButton({ entry }: { entry: SidebarInboxEntry }) {
  return (
    <div className="shrink-0" data-testid="sidebar-inbox-row-wrapper">
      <button
        type="button"
        data-active={entry.active ? "true" : undefined}
        aria-current={entry.active ? "page" : undefined}
        className={cn(SIDEBAR_NEW_CHAT_ROW_CLASS, entry.active && "bg-token-list-hover-background")}
        onClick={entry.onOpen}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 text-base text-token-foreground">
          <InboxIcon className="icon-xs" />
          <span className="truncate">Inbox</span>
        </div>
        {entry.count > 0 ? (
          <span
            aria-label={`${entry.count} in Inbox`}
            className="text-xs text-token-description-foreground tabular-nums group-hover:hidden group-focus-visible:hidden"
          >
            {entry.count}
          </span>
        ) : null}
        <span aria-hidden="true" className="hidden group-hover:inline group-focus-visible:inline">
          <ShortcutKeycaps keys={[entry.shortcutLabel]} tone="current" />
        </span>
      </button>
    </div>
  );
}

function stopProjectActionPropagation(
  event:
    | MouseEvent<HTMLButtonElement>
    | PointerEvent<HTMLButtonElement>
    | KeyboardEvent<HTMLButtonElement>,
) {
  event.stopPropagation();
}

export function SidebarNewChatButton({
  shortcutLabel,
  onClick,
}: {
  shortcutLabel: string;
  onClick: () => void;
}) {
  return (
    <div className="shrink-0" data-testid="sidebar-new-chat-row-wrapper">
      <div className="flex flex-col gap-1">
        <div className="flex flex-col gap-px">
          <button type="button" className={SIDEBAR_NEW_CHAT_ROW_CLASS} onClick={onClick}>
            <div className="flex min-w-0 items-center text-base gap-2 flex-1 text-token-foreground">
              <TitlebarNewChatIcon className="icon-xs" />
              <span className="truncate">New chat</span>
            </div>
            <span
              aria-hidden="true"
              className="opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
            >
              <ShortcutKeycaps keys={[shortcutLabel]} tone="current" />
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

export function SidebarProjectNewChatButton({
  label,
  disabledLabel,
  disabled,
  className,
  onClick,
}: {
  label: string;
  disabledLabel?: string;
  disabled?: boolean;
  className?: string;
  onClick: () => void;
}) {
  return (
    <div className="relative mr-0.5 h-6 w-6 shrink-0" data-testid="project-new-chat-action-shell">
      <NodexTooltip
        delayOpen
        tooltipContent={disabled ? (disabledLabel ?? label) : label}
        side="right"
      >
        <span className={cn("inline-flex opacity-0 group-hover/folder-row:opacity-100", className)}>
          <button
            type="button"
            className={SIDEBAR_PROJECT_NEW_CHAT_BUTTON_CLASS}
            aria-label={label}
            disabled={disabled}
            onPointerDown={stopProjectActionPropagation}
            onMouseDown={stopProjectActionPropagation}
            onKeyDown={stopProjectActionPropagation}
            onClick={(event) => {
              event.stopPropagation();
              onClick();
            }}
          >
            <NewChatIcon />
          </button>
        </span>
      </NodexTooltip>
    </div>
  );
}

export function SidebarCompactNewChatButton({
  label = "New chat",
  tooltipSide = "bottom",
  disabled,
  onClick,
}: {
  label?: string;
  tooltipSide?: "top" | "right" | "bottom" | "left";
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <NodexTooltip delayOpen tooltipContent={label} side={tooltipSide}>
      <button
        type="button"
        className={SIDEBAR_COLLAPSED_CHROME_BUTTON_CLASS}
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
      >
        <TitlebarNewChatIcon className="icon-sm" />
      </button>
    </NodexTooltip>
  );
}
