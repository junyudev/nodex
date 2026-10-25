import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import {
  NodexPopover,
  NodexPopoverContent,
  NodexPopoverTrigger,
  type NodexPopoverContentProps,
} from "@/components/ui/popover";
import { NodexTooltip } from "@/components/ui/tooltip";
import {
  CODEX_SUMMARY_PANEL_TRANSITION,
  CODEX_SUMMARY_PANEL_WIDTH,
} from "@/lib/codex-panel-motion";
import { useResolvedReducedMotion } from "@/lib/use-reduced-motion";
import { cn } from "@/lib/utils";
import { ThreadSummaryPanelToggleButton } from "./thread-summary-panel-toggle";

const VISIBLE = { opacity: 1, transform: "translateX(0%)" };
const HIDDEN = { opacity: 0, transform: "translateX(100%)" };

function summaryPane(trigger: HTMLElement | null): HTMLElement | null {
  return (
    trigger
      ?.closest("[data-workbench-shell]")
      ?.querySelector("[data-app-shell-main-content-layout]") ?? null
  );
}

/** The summary follows the chat pane's edge, independently of the toolbar's other actions. */
function summaryAnchorRect(trigger: HTMLElement | null): DOMRect {
  const header =
    trigger?.closest("[data-workbench-pane-titlebar], [data-workbench-titlebar]") ?? trigger;
  const headerRect = header?.getBoundingClientRect() ?? new DOMRect();
  const paneRect = summaryPane(trigger)?.getBoundingClientRect();
  if (!paneRect) return headerRect;
  const left = Math.max(headerRect.left, paneRect.left);
  const right = Math.min(headerRect.right, paneRect.right);
  return new DOMRect(left, headerRect.top, Math.max(0, right - left), headerRect.height);
}

function useSummaryPopoverGeometry(trigger: HTMLElement | null) {
  const [geometry, setGeometry] = useState<{
    contextElement: HTMLElement | undefined;
    zoom: number;
  }>({ contextElement: undefined, zoom: 1 });
  useLayoutEffect(() => {
    if (!trigger) return;
    const contextElement = summaryPane(trigger) ?? trigger;
    const measure = () => {
      const value = Number.parseFloat(
        getComputedStyle(trigger).getPropertyValue("--codex-window-zoom"),
      );
      const zoom = Number.isFinite(value) && value > 0 ? value : 1;
      setGeometry((current) =>
        current.contextElement === contextElement && current.zoom === zoom
          ? current
          : { contextElement, zoom },
      );
    };
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(contextElement);
    const styles = new MutationObserver(measure);
    for (let element: HTMLElement | null = trigger; element; element = element.parentElement) {
      styles.observe(element, { attributes: true, attributeFilter: ["style"] });
    }
    return () => {
      resize.disconnect();
      styles.disconnect();
    };
  }, [trigger]);
  return geometry;
}

function SummaryPopoverContent({
  children,
  trigger,
  anchor,
  zoom,
}: {
  children: ReactNode;
  trigger: HTMLElement | null;
  anchor: NodexPopoverContentProps["anchor"];
  zoom: number;
}) {
  const reducedMotion = useResolvedReducedMotion();
  const present = useIsPresent();
  const popupRef = useRef<HTMLDivElement | null>(null);
  const animatingRef = useRef(false);
  const clipToPane = () => {
    const popup = popupRef.current;
    const pane = summaryPane(trigger);
    if (!popup || !pane || !animatingRef.current) return;
    const bounds = pane.getBoundingClientRect();
    const rectangle = popup.getBoundingClientRect();
    const zoom = popup.offsetWidth > 0 ? rectangle.width / popup.offsetWidth : 1;
    popup.style.clipPath = `inset(${(bounds.top - rectangle.top) / zoom}px ${(rectangle.right - bounds.right) / zoom}px ${(rectangle.bottom - bounds.bottom) / zoom}px ${(bounds.left - rectangle.left) / zoom}px)`;
  };

  return (
    <NodexPopoverContent
      ref={popupRef}
      keepMounted
      anchor={anchor}
      align="end"
      alignOffset={8 * zoom}
      side="bottom"
      sideOffset={8 * zoom}
      collisionPadding={8 * zoom}
      aria-hidden={!present}
      inert={!present}
      finalFocus={false}
      className="!w-auto !overflow-visible !rounded-3xl !bg-transparent !p-0 !shadow-none !ring-0 !backdrop-blur-none"
      style={{ maxHeight: "none", maxWidth: "none", zoom }}
      render={
        <motion.div
          initial={reducedMotion ? false : HIDDEN}
          animate={VISIBLE}
          exit={HIDDEN}
          transition={reducedMotion ? { duration: 0 } : CODEX_SUMMARY_PANEL_TRANSITION}
          onAnimationStart={() => {
            animatingRef.current = true;
            clipToPane();
          }}
          onUpdate={clipToPane}
          onAnimationComplete={() => {
            animatingRef.current = false;
            popupRef.current?.style.removeProperty("clip-path");
          }}
        />
      }
    >
      <div
        data-thread-summary-panel-mode="popover"
        className="flex flex-col"
        style={{
          width: CODEX_SUMMARY_PANEL_WIDTH,
          maxHeight: `min(calc(var(--nodex-floating-surface-available-height) / ${zoom}), calc(100vh / ${zoom} - 16px))`,
        }}
      >
        {children}
      </div>
    </NodexPopoverContent>
  );
}

export function ThreadSummaryPanelPopoverShell({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  const returnFocusRef = useRef(true);
  const { contextElement, zoom } = useSummaryPopoverGeometry(trigger);
  const anchor = {
    contextElement,
    getBoundingClientRect: () => summaryAnchorRect(trigger),
  };
  return (
    <NodexPopover
      open={open}
      onOpenChangeComplete={(isOpen) => {
        // A canceled tab focus-out can suppress the popup engine's default restoration.
        if (!isOpen && returnFocusRef.current) trigger?.focus({ preventScroll: true });
      }}
      onOpenChange={(nextOpen, details) => {
        const target =
          details.reason === "focus-out" && details.event instanceof FocusEvent
            ? details.event.relatedTarget
            : details.event.target;
        if (!nextOpen && target instanceof Element) {
          const rightTab =
            (details.reason === "outside" || details.reason === "focus-out") &&
            target.closest(
              '[data-panel-tab-row^="right:"], [data-app-shell-tab-controller="right"]',
            );
          const rightPanelFocus =
            details.reason === "focus-out" &&
            target.matches('[role="tabpanel"][data-app-shell-tab-panel-controller="right"]');
          if (rightTab || rightPanelFocus) {
            details.cancel();
            return;
          }
        }
        returnFocusRef.current =
          nextOpen || (details.reason !== "outside" && details.reason !== "focus-out");
        onOpenChange(nextOpen);
      }}
    >
      <NodexTooltip tooltipContent="Toggle summary" side="bottom">
        <NodexPopoverTrigger>
          <ThreadSummaryPanelToggleButton ref={setTrigger} label="Toggle summary" pressed={open} />
        </NodexPopoverTrigger>
      </NodexTooltip>
      <AnimatePresence>
        {open ? (
          <SummaryPopoverContent trigger={trigger} anchor={anchor} zoom={zoom}>
            {children}
          </SummaryPopoverContent>
        ) : null}
      </AnimatePresence>
    </NodexPopover>
  );
}

export function ThreadPinnedSummaryPanelShell({
  hideImmediately = false,
  open,
  children,
}: {
  hideImmediately?: boolean;
  open: boolean;
  children: ReactNode;
}) {
  const reducedMotion = useResolvedReducedMotion();
  const interactive = open && !hideImmediately;
  return (
    <div
      className="pointer-events-none absolute top-(--thread-floating-content-top-inset) right-0 bottom-(--thread-floating-content-bottom-inset) z-40 max-w-full"
      data-thread-summary-panel-hide-immediately={String(hideImmediately)}
      data-thread-summary-panel-mode="pinned"
      data-thread-summary-panel-open={String(open)}
      aria-hidden={!interactive}
      inert={!interactive}
    >
      <div className="relative isolate flex max-h-full max-w-full pe-2">
        <motion.div
          className={cn(
            "pointer-events-none max-h-full min-h-0 min-w-0 max-w-full",
            hideImmediately && "invisible",
          )}
          initial={false}
          animate={open ? VISIBLE : HIDDEN}
          transition={
            hideImmediately || reducedMotion ? { duration: 0 } : CODEX_SUMMARY_PANEL_TRANSITION
          }
        >
          <div
            className={cn(
              "flex max-h-full min-h-0 max-w-full flex-col",
              interactive ? "pointer-events-auto" : "pointer-events-none",
            )}
            style={{ width: CODEX_SUMMARY_PANEL_WIDTH }}
          >
            {children}
          </div>
        </motion.div>
      </div>
    </div>
  );
}
