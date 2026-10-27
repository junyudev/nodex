import type { KeyboardEvent, ReactNode, WheelEvent } from "react";
import { cn } from "@/lib/utils";

export interface BrowseTab<K extends string> {
  readonly key: K;
  readonly name: ReactNode;
}

/** Roving-focus pill tabs for a browse page; arrows move and select, Home/End jump. */
export function BrowseTabs<K extends string>({
  tabs,
  selectedKey,
  onSelect,
  onTabHover,
  ariaLabel,
  className,
}: {
  readonly tabs: readonly BrowseTab<K>[];
  readonly selectedKey: K;
  readonly onSelect: (key: K) => void;
  readonly onTabHover?: (key: K) => void;
  readonly ariaLabel: string;
  readonly className?: string;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabElements = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'),
    );
    const current = tabElements.findIndex((element) => element === event.target);
    if (current < 0) return;
    event.preventDefault();
    event.stopPropagation();
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabElements.length - 1
          : (current +
              (event.key === (rtl ? "ArrowLeft" : "ArrowRight") ? 1 : -1) +
              tabElements.length) %
            tabElements.length;
    tabElements[next]?.focus();
    tabElements[next]?.scrollIntoView({ block: "nearest", inline: "nearest" });
    const tab = tabs[next];
    if (tab) onSelect(tab.key);
  };
  // A vertical wheel scrolls an overflowing strip sideways.
  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    const delta = event.deltaX || event.deltaY;
    if (delta !== 0) event.currentTarget.scrollLeft += delta;
  };

  return (
    <div
      role="tablist"
      tabIndex={-1}
      aria-label={ariaLabel}
      className={cn(
        "flex min-w-0 items-center gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
      onKeyDown={onKeyDown}
      onWheel={onWheel}
    >
      {tabs.map((tab) => {
        const selected = tab.key === selectedKey;
        return (
          <div key={tab.key} className="relative flex min-w-0 shrink-0 items-center">
            <button
              type="button"
              role="tab"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              className={cn(
                "flex h-9 min-w-0 cursor-interaction items-center rounded-full border border-transparent px-4 py-0 text-sm font-medium select-none ring-inset focus:outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border",
                selected
                  ? "bg-token-list-hover-background text-token-foreground"
                  : "text-(--color-text-secondary) hover:bg-token-list-hover-background/50 hover:text-token-foreground",
              )}
              onPointerEnter={onTabHover ? () => onTabHover(tab.key) : undefined}
              onClick={() => {
                if (!selected) onSelect(tab.key);
              }}
            >
              {tab.name}
            </button>
          </div>
        );
      })}
    </div>
  );
}
