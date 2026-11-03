import { forwardRef, useCallback, type ForwardedRef, type ReactNode } from "react";
import { RIGHT_PANEL_COMPOSER_OVERLAY_SCROLL_RESERVE_STYLE } from "@/lib/right-panel-composer-overlay-reserve";
import { useRetainedScrollPosition } from "@/lib/retained-scroll-position";

export const BOARD_SCROLL_CONTAINER_TEST_ID = "board-scroll-container";
export const TOGGLE_LIST_SCROLL_CONTAINER_TEST_ID = "toggle-list-scroll-container";

interface ViewScrollContainerProps {
  children: ReactNode;
  scrollStateKey?: string | null;
}

function setForwardedRef<T>(ref: ForwardedRef<T>, value: T | null): void {
  if (!ref) return;
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  ref.current = value;
}

export const BoardScrollContainer = forwardRef<HTMLDivElement, ViewScrollContainerProps>(
  function BoardScrollContainer({ children, scrollStateKey }, ref) {
    const retainedScroll = useRetainedScrollPosition<HTMLDivElement>(scrollStateKey ?? null, {
      axis: "both",
      retryFrames: 2,
    });
    const retainedScrollRef = retainedScroll.ref;
    const setContainerRef = useCallback(
      (node: HTMLDivElement | null) => {
        retainedScrollRef(node);
        setForwardedRef(ref, node);
      },
      [ref, retainedScrollRef],
    );

    return (
      <div
        ref={setContainerRef}
        className="scrollbar-token min-h-0 flex-1 overflow-auto"
        data-testid={BOARD_SCROLL_CONTAINER_TEST_ID}
        onScroll={retainedScroll.onScroll}
        style={RIGHT_PANEL_COMPOSER_OVERLAY_SCROLL_RESERVE_STYLE}
      >
        {children}
      </div>
    );
  },
);

export function ToggleListScrollContainer({ children, scrollStateKey }: ViewScrollContainerProps) {
  const { ref: setScrollContainer, onScroll } = useRetainedScrollPosition<HTMLDivElement>(
    scrollStateKey ?? null,
    { axis: "vertical", retryFrames: 2 },
  );

  return (
    <div
      ref={setScrollContainer}
      className="scrollbar-token h-full min-h-0 overflow-y-auto"
      data-testid={TOGGLE_LIST_SCROLL_CONTAINER_TEST_ID}
      onScroll={onScroll}
      style={RIGHT_PANEL_COMPOSER_OVERLAY_SCROLL_RESERVE_STYLE}
    >
      {children}
    </div>
  );
}
