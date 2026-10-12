import { useEffect, useInsertionEffect, useLayoutEffect } from "react";
import { useResolvedReducedMotion } from "@/lib/use-reduced-motion";
import { useLocalConversationThreadScrollController } from "./local-conversation-thread-scroll-controller";
import type { ThreadResponseSpaceController } from "./local-conversation-response-space";

const INTERSECTION_THRESHOLDS = Array.from({ length: 101 }, (_, index) => index / 100);

export function LocalConversationResponseSpaceElement({
  controller,
  onReleased,
}: {
  readonly controller: ThreadResponseSpaceController;
  readonly onReleased: () => void;
}) {
  const scroll = useLocalConversationThreadScrollController();
  const { getScrollElement, addScrollListener, addUserScrollListener, scrollElement } = scroll;
  const reducedMotion = useResolvedReducedMotion();
  useInsertionEffect(() => {
    controller.updateContext(scroll, reducedMotion, onReleased);
  }, [controller, onReleased, reducedMotion, scroll]);
  useEffect(() => {
    const element = getScrollElement();
    if (!element) return;
    const abort = new AbortController();
    for (const event of ["wheel", "touchstart", "pointerdown", "keydown"]) {
      element.addEventListener(event, controller.stop, {
        capture: true,
        passive: true,
        signal: abort.signal,
      });
    }
    return () => {
      abort.abort();
      controller.stop();
    };
  }, [controller, getScrollElement, scrollElement]);
  useEffect(() => controller.cancelPendingUserScrollDecay, [controller]);
  useLayoutEffect(() => {
    const element = getScrollElement();
    const spacer = controller.getElement();
    if (!element || !spacer || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(controller.collapseIfHidden, {
      root: element,
      threshold: INTERSECTION_THRESHOLDS,
    });
    observer.observe(spacer);
    return () => observer.disconnect();
  }, [controller, getScrollElement, scrollElement]);
  useLayoutEffect(() => {
    const releaseScroll = addScrollListener(controller.handleScroll);
    const releaseUser = addUserScrollListener(controller.handleUserScroll);
    return () => {
      releaseScroll();
      releaseUser();
    };
  }, [controller, addScrollListener, addUserScrollListener]);
  useLayoutEffect(() => {
    const element = getScrollElement();
    if (!element) return;
    controller.reconcileViewport();
    let frame: number | null = null;
    const schedule = () => {
      frame ??= window.requestAnimationFrame(() => {
        frame = null;
        controller.reconcileViewport();
      });
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(element);
    const footer = element.parentElement?.querySelector("[data-thread-scroll-footer]");
    if (footer) observer?.observe(footer);
    window.addEventListener("resize", schedule, { passive: true });
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [controller, getScrollElement, scrollElement]);
  return <div ref={controller.setElement} className="shrink-0" aria-hidden="true" />;
}
