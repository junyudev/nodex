import { useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface ScrollGesture {
  pointerId: number;
  startX: number;
  startY: number;
  scrollLeft: number;
  zoom: number;
  target: Element;
  dragged: boolean;
}

const DRAG_THRESHOLD = 4;

/** Keeps the context controls reachable while the configuration control stays pinned. */
export function ComposerContextControls({ children }: { children: ReactNode }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<ScrollGesture | null>(null);
  const replayingPressRef = useRef(false);
  const suppressClickRef = useRef(false);
  const clearClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    const measure = () => setOverflowing(scroller.scrollWidth > scroller.clientWidth);
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    observer.observe(content);
    measure();
    return () => {
      observer.disconnect();
      const gesture = gestureRef.current;
      gestureRef.current = null;
      if (gesture && scroller.hasPointerCapture?.(gesture.pointerId)) {
        scroller.releasePointerCapture(gesture.pointerId);
      }
      if (clearClickTimerRef.current !== null) clearTimeout(clearClickTimerRef.current);
    };
  }, []);

  function finishGesture(event: PointerEvent<HTMLDivElement>, activate: boolean) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (gesture.dragged) {
      event.preventDefault();
      event.stopPropagation();
      clearClickTimerRef.current = setTimeout(() => {
        suppressClickRef.current = false;
        clearClickTimerRef.current = null;
      }, 0);
      return;
    }
    if (!activate) return;

    const trigger = gesture.target.closest<HTMLElement>('[aria-haspopup="menu"]');
    if (!trigger) {
      gesture.target.closest<HTMLElement>('button, a, [role="button"]')?.focus();
      return;
    }
    if (
      !(event.target instanceof Element) ||
      event.target.closest('[aria-haspopup="menu"]') !== trigger
    ) {
      return;
    }
    trigger.focus();
    // Menu triggers own press behavior. Defer their pointer/mouse sequence until
    // the gesture resolves as a click; the browser still delivers the final click.
    const pointerInit = {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      clientX: event.clientX,
      clientY: event.clientY,
      pointerId: event.pointerId,
      pointerType: "mouse",
      isPrimary: true,
      width: 1,
      height: 1,
      pressure: 0.5,
      detail: 1,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
    };
    replayingPressRef.current = true;
    try {
      trigger.dispatchEvent(new window.PointerEvent("pointerdown", pointerInit));
      trigger.dispatchEvent(new MouseEvent("mousedown", pointerInit));
      trigger.dispatchEvent(
        new window.PointerEvent("pointerup", { ...pointerInit, buttons: 0, pressure: 0 }),
      );
      trigger.dispatchEvent(new MouseEvent("mouseup", { ...pointerInit, buttons: 0 }));
    } finally {
      replayingPressRef.current = false;
    }
  }

  return (
    <div
      ref={scrollRef}
      role="group"
      aria-label="Composer utility bar"
      data-composer-utility-bar-scroll-area="true"
      className={cn(
        "horizontal-scroll-fade-mask hide-scrollbar order-2 -m-0.5 min-w-0 flex-1 overflow-x-auto overflow-y-hidden",
        overflowing && "cursor-grab active:cursor-grabbing",
      )}
      onPointerDownCapture={(event) => {
        if (
          replayingPressRef.current ||
          event.button !== 0 ||
          event.pointerType !== "mouse" ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          event.currentTarget.scrollWidth <= event.currentTarget.clientWidth ||
          !(event.target instanceof Element) ||
          !event.currentTarget.contains(event.target)
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        const zoom = Number.parseFloat(
          window.getComputedStyle(event.currentTarget).getPropertyValue("--codex-window-zoom"),
        );
        gestureRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          scrollLeft: event.currentTarget.scrollLeft,
          zoom: Number.isFinite(zoom) && zoom > 0 ? zoom : 1,
          target: event.target,
          dragged: false,
        };
      }}
      onMouseDownCapture={(event) => {
        if (!gestureRef.current || replayingPressRef.current) return;
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerMove={(event) => {
        const gesture = gestureRef.current;
        if (!gesture || gesture.pointerId !== event.pointerId) return;
        if (event.buttons !== 1) {
          finishGesture(event, false);
          return;
        }
        const delta = event.clientX - gesture.startX;
        if (!gesture.dragged && Math.abs(delta) <= DRAG_THRESHOLD) {
          if (
            Math.abs(event.clientY - gesture.startY) > DRAG_THRESHOLD &&
            gesture.target.closest('[aria-haspopup="menu"]')
          ) {
            finishGesture(event, true);
          }
          return;
        }
        if (!gesture.dragged) {
          gesture.dragged = true;
          suppressClickRef.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
        }
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.scrollLeft = gesture.scrollLeft - delta / gesture.zoom;
      }}
      onPointerUp={(event) => finishGesture(event, true)}
      onPointerCancel={(event) => finishGesture(event, false)}
      onLostPointerCapture={(event) => finishGesture(event, false)}
      onClickCapture={(event) => {
        if (!suppressClickRef.current || event.detail === 0) return;
        suppressClickRef.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div ref={contentRef} className="flex w-max min-w-full items-center gap-2 p-0.5">
        {children}
      </div>
    </div>
  );
}
