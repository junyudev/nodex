import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import { NodexTooltip } from "@/components/ui/tooltip";
import { useResolvedReducedMotion } from "@/lib/use-reduced-motion";
import { cn } from "@/lib/utils";
import {
  MARKER_NAVIGATION_MAX_VIRTUAL_VIEWPORT_PX,
  MARKER_NAVIGATION_ROW_HEIGHT_PX,
  MARKER_NAVIGATION_VIRTUALIZE_AFTER,
  projectMarkerNavigationVirtualWindow,
} from "./marker-navigation-window";

export type MarkerNavigationRevealMode = "smooth" | "instant";

export interface MarkerNavigationItem {
  id: string;
  ordinal: number;
}

export interface MarkerNavigationObservationTarget {
  element: HTMLElement;
  itemId: string;
}

export type MarkerNavigationRailSide = "left" | "right";

export const MARKER_NAVIGATION_SIDE_INSET_PX = 12;
export const MARKER_NAVIGATION_ROW_WIDTH_PX = 36;
export const MARKER_NAVIGATION_MIN_SIDE_SPACE_PX =
  MARKER_NAVIGATION_SIDE_INSET_PX + MARKER_NAVIGATION_ROW_WIDTH_PX;

export function escapeMarkerNavigationAttributeSelectorValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }

  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function nextMarkerNavigationAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

export function resolveMarkerNavigationCurrentRangeIds<TItem extends MarkerNavigationItem>(
  items: readonly TItem[],
  visibleIds: ReadonlySet<string>,
): Set<string> | null {
  const firstVisibleIndex = items.findIndex((item) => visibleIds.has(item.id));
  if (firstVisibleIndex < 0) return null;

  let lastVisibleIndex = firstVisibleIndex;
  for (let index = firstVisibleIndex + 1; index < items.length; index += 1) {
    const itemId = items[index]?.id;
    if (itemId && visibleIds.has(itemId)) {
      lastVisibleIndex = index;
    }
  }

  return new Set(items.slice(firstVisibleIndex, lastVisibleIndex + 1).map((item) => item.id));
}

export function collectMarkerNavigationObservationTargets({
  root,
  itemIds,
  targetSelector,
  containerSelector,
  readItemId,
}: {
  root: ParentNode;
  itemIds: ReadonlySet<string>;
  targetSelector: string;
  containerSelector?: string;
  readItemId: (target: HTMLElement) => string | undefined;
}): MarkerNavigationObservationTarget[] {
  const targets: MarkerNavigationObservationTarget[] = [];
  const usedContainers = new Set<HTMLElement>();
  const usedObservedElements = new Set<HTMLElement>();

  for (const target of root.querySelectorAll<HTMLElement>(targetSelector)) {
    const itemId = readItemId(target);
    if (!itemId || !itemIds.has(itemId)) continue;

    const container = containerSelector ? target.closest<HTMLElement>(containerSelector) : null;
    const observedElement = container && !usedContainers.has(container) ? container : target;

    if (observedElement === container) {
      usedContainers.add(container);
    }
    if (usedObservedElements.has(observedElement)) continue;

    usedObservedElements.add(observedElement);
    targets.push({ element: observedElement, itemId });
  }

  return targets;
}

export function markerNavigationMutationsIncludeContainer(
  records: readonly MutationRecord[],
  containerSelector: string,
): boolean {
  return records.some((record) =>
    [...record.addedNodes, ...record.removedNodes].some(
      (node) =>
        node instanceof HTMLElement &&
        (node.matches(containerSelector) || node.querySelector(containerSelector) !== null),
    ),
  );
}

export function ensureMarkerNavigationRowVisible(
  listElement: HTMLElement | null,
  activeItemId: string | null,
) {
  if (!listElement || !activeItemId) return;
  const row = listElement.querySelector<HTMLElement>(
    `[data-marker-navigation-item-id="${escapeMarkerNavigationAttributeSelectorValue(activeItemId)}"]`,
  );
  if (!row) return;

  if (row.offsetTop < listElement.scrollTop) {
    listElement.scrollTop = row.offsetTop;
    return;
  }

  if (row.offsetTop + row.offsetHeight > listElement.scrollTop + listElement.clientHeight) {
    listElement.scrollTop = row.offsetTop + row.offsetHeight - listElement.clientHeight + 1;
  }
}

export function hasEnoughMarkerNavigationSideSpace({
  scrollElement,
  contentElement,
  side,
}: {
  scrollElement: HTMLElement;
  contentElement: HTMLElement;
  side: MarkerNavigationRailSide;
}): boolean {
  const scrollRect = scrollElement.getBoundingClientRect();
  const contentRect = contentElement.getBoundingClientRect();
  const scale = scrollElement.offsetWidth > 0 ? scrollRect.width / scrollElement.offsetWidth : 1;
  const sideSpace =
    side === "left" ? contentRect.left - scrollRect.left : scrollRect.right - contentRect.right;
  const normalizedSideSpace = sideSpace / (scale > 0 ? scale : 1);
  return normalizedSideSpace >= MARKER_NAVIGATION_MIN_SIDE_SPACE_PX;
}

export function sameMarkerNavigationSet(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

export function useMarkerNavigationIdleReady(itemCount: number, minItems: number): boolean {
  const [idleReady, setIdleReady] = useState(false);

  useEffect(() => {
    if (itemCount < minItems) {
      setIdleReady(false);
      return undefined;
    }

    let cancelled = false;
    const markReady = () => {
      if (cancelled) return;
      setIdleReady(true);
    };

    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(markReady, { timeout: 2000 });
      return () => {
        cancelled = true;
        window.cancelIdleCallback(handle);
      };
    }

    const timeout = window.setTimeout(markReady, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [itemCount, minItems]);

  return idleReady;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export interface MarkerNavigationRailProps<TItem extends MarkerNavigationItem> {
  items: TItem[];
  ariaLabel: string;
  rowAriaLabel: (item: TItem) => string;
  scrollElement: HTMLElement | null;
  contentElement: HTMLElement | null;
  portalTarget: HTMLElement | null;
  findTarget: (scrollElement: HTMLElement, item: TItem) => HTMLElement | null;
  collectObservationTargets: (
    root: ParentNode,
    itemIds: ReadonlySet<string>,
  ) => MarkerNavigationObservationTarget[];
  mutationsIncludeObservationTargets: (records: readonly MutationRecord[]) => boolean;
  scrollTargetIntoView: (
    targetElement: HTMLElement,
    behavior: ScrollBehavior,
    item: TItem,
    mode: MarkerNavigationRevealMode,
  ) => void;
  renderTooltipContent: (item: TItem) => ReactNode;
  highlightTarget?: (targetElement: HTMLElement, item: TItem) => void;
  onRevealMissingItem?: (
    item: TItem,
    mode: MarkerNavigationRevealMode,
  ) => HTMLElement | null | Promise<HTMLElement | null>;
  onClickItem?: (item: TItem) => void;
  onItemPreviewIntent?: (item: TItem) => void;
  getRowDataAttributes?: (item: TItem) => Record<string, string | undefined>;
  listDataAttributes?: Record<string, string | undefined>;
  markerClassName?: string;
  navClassName?: string;
  side?: MarkerNavigationRailSide;
  tooltipSide?: "top" | "right" | "bottom" | "left";
  virtualizeAfter?: number;
}

export function MarkerNavigationRail<TItem extends MarkerNavigationItem>({
  items,
  ariaLabel,
  rowAriaLabel,
  scrollElement,
  contentElement,
  portalTarget,
  findTarget,
  collectObservationTargets,
  mutationsIncludeObservationTargets,
  scrollTargetIntoView,
  renderTooltipContent,
  highlightTarget,
  onRevealMissingItem,
  onClickItem,
  onItemPreviewIntent,
  getRowDataAttributes,
  listDataAttributes,
  markerClassName,
  navClassName,
  side = "left",
  tooltipSide,
  virtualizeAfter = Number.POSITIVE_INFINITY,
}: MarkerNavigationRailProps<TItem>) {
  const reducedMotion = useResolvedReducedMotion();
  const listRef = useRef<HTMLDivElement | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const suppressNextClickRef = useRef(false);
  const isScrubbingRef = useRef(false);
  const [currentItemIds, setCurrentItemIds] = useState<Set<string>>(
    () => new Set(items.length > 0 ? [items[items.length - 1]?.id ?? ""] : []),
  );
  const [scrubTargetId, setScrubTargetId] = useState<string | null>(null);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [canRender, setCanRender] = useState(false);
  const [keyboardFocusItemId, setKeyboardFocusItemId] = useState<string | null>(null);
  const [virtualViewport, setVirtualViewport] = useState(() => ({
    scrollTop: Math.max(0, items.length * MARKER_NAVIGATION_ROW_HEIGHT_PX - 400),
    height: 400,
  }));

  useEffect(() => {
    isScrubbingRef.current = isScrubbing;
  }, [isScrubbing]);

  const lastItemId = items[items.length - 1]?.id ?? null;
  const itemIds = useMemo(() => new Set(items.map((item) => item.id)), [items]);
  const itemsById = useMemo(() => new Map(items.map((item) => [item.id, item] as const)), [items]);
  const itemIndexById = useMemo(
    () => new Map(items.map((item, index) => [item.id, index] as const)),
    [items],
  );
  const itemIdsKey = useMemo(() => items.map((item) => item.id).join("\n"), [items]);
  const shouldVirtualize =
    items.length >= Math.max(MARKER_NAVIGATION_VIRTUALIZE_AFTER, virtualizeAfter);
  const virtualWindow = useMemo(
    () =>
      projectMarkerNavigationVirtualWindow({
        itemCount: items.length,
        scrollTop: virtualViewport.scrollTop,
        viewportHeight: virtualViewport.height,
      }),
    [items.length, virtualViewport.height, virtualViewport.scrollTop],
  );
  const renderedItems = shouldVirtualize
    ? items.slice(virtualWindow.startIndex, virtualWindow.endIndex)
    : items;

  useEffect(() => {
    setCurrentItemIds((current) => {
      const next = new Set([...current].filter((id) => itemIds.has(id)));
      if (next.size > 0) {
        return sameMarkerNavigationSet(current, next) ? current : next;
      }
      return new Set(lastItemId ? [lastItemId] : []);
    });
  }, [itemIds, itemIdsKey, lastItemId]);

  const currentPrimaryItemId = useMemo(
    () => items.find((item) => currentItemIds.has(item.id))?.id ?? lastItemId,
    [currentItemIds, items, lastItemId],
  );

  useLayoutEffect(() => {
    const listElement = listRef.current;
    if (!listElement || !shouldVirtualize) return;
    const activeIndex = Math.max(0, itemIndexById.get(currentPrimaryItemId ?? "") ?? -1);
    const height = Math.min(
      listElement.clientHeight || 400,
      MARKER_NAVIGATION_MAX_VIRTUAL_VIEWPORT_PX,
    );
    const rowTop = activeIndex * MARKER_NAVIGATION_ROW_HEIGHT_PX;
    const rowBottom = rowTop + MARKER_NAVIGATION_ROW_HEIGHT_PX;
    let scrollTop = listElement.scrollTop;
    if (rowTop < listElement.scrollTop || rowBottom > listElement.scrollTop + height) {
      scrollTop = Math.max(0, rowBottom - height);
      listElement.scrollTop = scrollTop;
    }
    setVirtualViewport({ scrollTop, height });
  }, [canRender, currentPrimaryItemId, itemIdsKey, itemIndexById, shouldVirtualize]);

  useEffect(() => {
    if (!scrollElement || !contentElement || !portalTarget) {
      setCanRender((current) => (current ? false : current));
      return undefined;
    }

    let frameId: number | null = null;
    const syncLayoutState = () => {
      if (frameId !== null) return;
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        const nextCanRender = hasEnoughMarkerNavigationSideSpace({
          scrollElement,
          contentElement,
          side,
        });
        setCanRender((current) => (current === nextCanRender ? current : nextCanRender));
        ensureMarkerNavigationRowVisible(listRef.current, currentPrimaryItemId);
      });
    };

    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(syncLayoutState);
    resizeObserver?.observe(scrollElement);
    resizeObserver?.observe(contentElement);

    const mutationObserver =
      typeof MutationObserver === "undefined" ? null : new MutationObserver(syncLayoutState);
    mutationObserver?.observe(scrollElement.firstElementChild ?? scrollElement, {
      attributes: true,
      attributeFilter: ["style"],
    });
    window.addEventListener("resize", syncLayoutState);
    syncLayoutState();

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener("resize", syncLayoutState);
    };
  }, [contentElement, currentPrimaryItemId, portalTarget, scrollElement, side]);

  const revealItem = useCallback(
    async (item: TItem, mode: MarkerNavigationRevealMode) => {
      if (!scrollElement) return;

      const behavior: ScrollBehavior = mode === "instant" || reducedMotion ? "auto" : "smooth";
      let targetElement = findTarget(scrollElement, item);
      if (!targetElement) {
        targetElement =
          (await onRevealMissingItem?.(item, mode)) ?? findTarget(scrollElement, item);
      }
      if (!targetElement) return;

      scrollTargetIntoView(targetElement, behavior, item, mode);
      await nextMarkerNavigationAnimationFrame();
      highlightTarget?.(targetElement, item);
    },
    [
      findTarget,
      highlightTarget,
      onRevealMissingItem,
      reducedMotion,
      scrollElement,
      scrollTargetIntoView,
    ],
  );

  useEffect(() => {
    if (!scrollElement) return undefined;
    if (items.length === 0) return undefined;
    if (typeof IntersectionObserver === "undefined") return undefined;

    const visibleIds = new Set<string>();
    const observedElements = new Set<HTMLElement>();
    const elementToItemId = new Map<HTMLElement, string>();

    const syncCurrentRange = () => {
      const rangeIds = resolveMarkerNavigationCurrentRangeIds(items, visibleIds);
      if (!rangeIds) return;
      setCurrentItemIds((current) =>
        sameMarkerNavigationSet(current, rangeIds) ? current : rangeIds,
      );
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!(entry.target instanceof HTMLElement)) continue;
          const id = elementToItemId.get(entry.target);
          if (!id) continue;
          if (entry.isIntersecting) {
            visibleIds.add(id);
          } else {
            visibleIds.delete(id);
          }
        }
        syncCurrentRange();
      },
      {
        root: scrollElement,
        rootMargin: "-16px 0px 0px 0px",
      },
    );

    const registerTargets = () => {
      const nextTargets = collectObservationTargets(scrollElement, itemIds);
      const nextElements = new Set(nextTargets.map((target) => target.element));

      for (const element of [...observedElements]) {
        if (nextElements.has(element)) continue;
        const id = elementToItemId.get(element);
        if (id) visibleIds.delete(id);
        elementToItemId.delete(element);
        observedElements.delete(element);
        observer.unobserve(element);
      }

      for (const target of nextTargets) {
        const previousId = elementToItemId.get(target.element);
        if (previousId && previousId !== target.itemId) {
          visibleIds.delete(previousId);
        }
        elementToItemId.set(target.element, target.itemId);
        if (!observedElements.has(target.element)) {
          observedElements.add(target.element);
          observer.observe(target.element);
        }
      }

      syncCurrentRange();
    };

    registerTargets();
    const mutationObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver((records) => {
            if (mutationsIncludeObservationTargets(records)) {
              registerTargets();
            }
          });
    mutationObserver?.observe(scrollElement, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      mutationObserver?.disconnect();
    };
  }, [
    collectObservationTargets,
    itemIds,
    itemIdsKey,
    items,
    mutationsIncludeObservationTargets,
    scrollElement,
  ]);

  useLayoutEffect(() => {
    if (isScrubbing) return;
    ensureMarkerNavigationRowVisible(listRef.current, currentPrimaryItemId);
  }, [currentPrimaryItemId, isScrubbing]);

  useEffect(() => {
    const listElement = listRef.current;
    if (!listElement || typeof ResizeObserver === "undefined") return undefined;

    const observer = new ResizeObserver(() => {
      if (!isScrubbingRef.current) {
        ensureMarkerNavigationRowVisible(listElement, currentPrimaryItemId);
      }
    });
    observer.observe(listElement);
    return () => {
      observer.disconnect();
    };
  }, [currentPrimaryItemId]);

  const resolveRowFromPoint = useCallback((event: PointerEvent | ReactPointerEvent) => {
    const listElement = listRef.current;
    if (!listElement) return null;

    const rect = listElement.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = clamp(event.clientY, rect.top + 1, rect.bottom - 1);
    const target = document.elementFromPoint(x, y);
    return target?.closest<HTMLElement>("[data-marker-navigation-item-id]") ?? null;
  }, []);

  const clearPointerScrub = useCallback((event?: ReactPointerEvent<HTMLButtonElement>) => {
    if (event && pointerIdRef.current !== event.pointerId) return;
    if (event?.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    pointerIdRef.current = null;
    pointerStartRef.current = null;
    suppressNextClickRef.current = isScrubbingRef.current;
    isScrubbingRef.current = false;
    setIsScrubbing(false);
    setScrubTargetId(null);
  }, []);

  const handlePointerDown = useCallback(
    (item: TItem, event: ReactPointerEvent<HTMLButtonElement>) => {
      if (!event.isPrimary || event.button !== 0) return;
      pointerIdRef.current = event.pointerId;
      pointerStartRef.current = { x: event.clientX, y: event.clientY };
      suppressNextClickRef.current = false;
      isScrubbingRef.current = false;
      setScrubTargetId(item.id);
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    [],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (pointerIdRef.current !== event.pointerId) return;
      const start = pointerStartRef.current;
      if (!start) return;

      if (!isScrubbing) {
        const delta = Math.abs(event.clientY - start.y) + Math.abs(event.clientX - start.x);
        if (delta < 2) return;
        isScrubbingRef.current = true;
        setIsScrubbing(true);
      }

      const row = resolveRowFromPoint(event);
      const id = row?.getAttribute("data-marker-navigation-item-id") ?? null;
      if (!id || id === scrubTargetId) return;

      const item = itemsById.get(id);
      if (!item) return;
      setScrubTargetId(id);
      void revealItem(item, "instant");
    },
    [isScrubbing, itemsById, revealItem, resolveRowFromPoint, scrubTargetId],
  );

  const handleClick = useCallback(
    (item: TItem, event: ReactMouseEvent<HTMLButtonElement>) => {
      if (suppressNextClickRef.current) {
        suppressNextClickRef.current = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      onClickItem?.(item);
      void revealItem(item, "smooth");
    },
    [onClickItem, revealItem],
  );

  const focusVirtualItem = useCallback(
    (item: TItem) => {
      setKeyboardFocusItemId(item.id);
      const listElement = listRef.current;
      if (!listElement || !shouldVirtualize) return;
      const index = itemIndexById.get(item.id) ?? -1;
      if (index < 0) return;
      const rowTop = index * MARKER_NAVIGATION_ROW_HEIGHT_PX;
      const viewportHeight = Math.min(
        listElement.clientHeight || virtualViewport.height,
        MARKER_NAVIGATION_MAX_VIRTUAL_VIEWPORT_PX,
      );
      let scrollTop = listElement.scrollTop;
      if (rowTop < listElement.scrollTop) {
        scrollTop = rowTop;
        listElement.scrollTop = scrollTop;
      } else if (
        rowTop + MARKER_NAVIGATION_ROW_HEIGHT_PX >
        listElement.scrollTop + viewportHeight
      ) {
        scrollTop = rowTop + MARKER_NAVIGATION_ROW_HEIGHT_PX - viewportHeight;
        listElement.scrollTop = scrollTop;
      }
      setVirtualViewport({
        scrollTop,
        height: viewportHeight,
      });
      requestAnimationFrame(() => {
        listElement
          .querySelector<HTMLElement>(
            `[data-marker-navigation-item-id="${escapeMarkerNavigationAttributeSelectorValue(item.id)}"]`,
          )
          ?.focus();
      });
    },
    [itemIndexById, shouldVirtualize, virtualViewport.height],
  );

  const handleRowKeyDown = useCallback(
    (item: TItem, event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (!shouldVirtualize) return;
      const index = itemIndexById.get(item.id) ?? -1;
      if (index < 0) return;
      const nextIndex =
        event.key === "ArrowUp"
          ? Math.max(0, index - 1)
          : event.key === "ArrowDown"
            ? Math.min(items.length - 1, index + 1)
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? items.length - 1
                : null;
      if (nextIndex === null || nextIndex === index) return;
      const nextItem = items[nextIndex];
      if (!nextItem) return;
      event.preventDefault();
      focusVirtualItem(nextItem);
    },
    [focusVirtualItem, itemIndexById, items, shouldVirtualize],
  );

  if (!canRender || !portalTarget || items.length === 0) return null;

  const resolvedTooltipSide = tooltipSide ?? (side === "left" ? "right" : "left");

  return createPortal(
    <motion.nav
      aria-label={ariaLabel}
      data-marker-navigation-rail-side={side}
      className={cn(
        "absolute top-1/2 z-20 -translate-y-1/2",
        side === "left" ? "left-3 electron:left-4" : "right-3 electron:right-4",
        navClassName,
      )}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: reducedMotion ? 0 : 0.15 }}
    >
      <div
        ref={listRef}
        data-marker-navigation-rail-list="true"
        data-scrubbing={scrubTargetId !== null ? "true" : undefined}
        className="vertical-scroll-fade-mask hide-scrollbar flex max-h-[min(70vh,40rem)] flex-col overflow-y-auto overscroll-contain [--edge-fade-distance:2.5rem]"
        onScroll={(event) => {
          if (!shouldVirtualize) return;
          setVirtualViewport({
            scrollTop: event.currentTarget.scrollTop,
            height: Math.min(
              event.currentTarget.clientHeight || virtualViewport.height,
              MARKER_NAVIGATION_MAX_VIRTUAL_VIEWPORT_PX,
            ),
          });
        }}
        {...listDataAttributes}
      >
        {shouldVirtualize && virtualWindow.paddingBeforePx > 0 ? (
          <div aria-hidden="true" style={{ height: virtualWindow.paddingBeforePx, flex: "none" }} />
        ) : null}
        {renderedItems.map((item) => {
          const isCurrent = currentItemIds.has(item.id);
          const isScrubTarget = scrubTargetId === item.id;
          const globalIndex = itemIndexById.get(item.id) ?? -1;
          const activeKeyboardItemId = keyboardFocusItemId ?? currentPrimaryItemId;
          return (
            <NodexTooltip
              key={item.id}
              tooltipContent={renderTooltipContent(item)}
              side={resolvedTooltipSide}
              align="center"
              sideOffset={0}
              delayOpen
              open={isScrubTarget && scrubTargetId !== null ? true : undefined}
              onOpenChange={(open) => {
                if (open) onItemPreviewIntent?.(item);
              }}
              surface="rich"
              tooltipClassName="!m-0 !rounded-xl !border-0 !bg-transparent !p-0 !shadow-none !ring-0 !backdrop-blur-none"
              tooltipBodyClassName="block w-full"
            >
              <button
                type="button"
                data-marker-navigation-item-id={item.id}
                data-scrub-target={isScrubTarget ? "true" : undefined}
                aria-label={rowAriaLabel(item)}
                aria-current={isCurrent ? "true" : undefined}
                aria-posinset={shouldVirtualize ? globalIndex + 1 : undefined}
                aria-setsize={shouldVirtualize ? items.length : undefined}
                tabIndex={
                  shouldVirtualize ? (item.id === activeKeyboardItemId ? 0 : -1) : undefined
                }
                className={cn(
                  "group/navigation-row flex h-2.5 w-9 shrink-0 cursor-interaction items-center outline-none",
                  side === "right" && "justify-end",
                )}
                onPointerDown={(event) => handlePointerDown(item, event)}
                onPointerMove={handlePointerMove}
                onPointerUp={clearPointerScrub}
                onPointerCancel={clearPointerScrub}
                onLostPointerCapture={clearPointerScrub}
                onClick={(event) => handleClick(item, event)}
                onFocus={() => {
                  setKeyboardFocusItemId(item.id);
                  onItemPreviewIntent?.(item);
                }}
                onKeyDown={(event) => handleRowKeyDown(item, event)}
                {...getRowDataAttributes?.(item)}
              >
                <span className="flex h-0.5 w-[30px] items-center">
                  <span
                    className={cn(
                      "marker-navigation-marker block h-0.5 rounded-full bg-token-description-foreground opacity-40",
                      markerClassName,
                      "group-focus-visible/navigation-row:bg-token-foreground group-focus-visible/navigation-row:opacity-100",
                      scrubTargetId === null &&
                        "group-hover/navigation-row:bg-token-foreground group-hover/navigation-row:opacity-100",
                      isCurrent && !isScrubTarget && "bg-token-foreground opacity-60",
                      isScrubTarget && "bg-token-foreground opacity-100",
                    )}
                  />
                </span>
              </button>
            </NodexTooltip>
          );
        })}
        {shouldVirtualize && virtualWindow.paddingAfterPx > 0 ? (
          <div aria-hidden="true" style={{ height: virtualWindow.paddingAfterPx, flex: "none" }} />
        ) : null}
      </div>
    </motion.nav>,
    portalTarget,
  );
}
