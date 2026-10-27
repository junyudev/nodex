import { useCallback, useEffect, useInsertionEffect, useLayoutEffect } from "react";
import { useResolvedReducedMotion } from "@/lib/use-reduced-motion";
import { useLocalConversationThreadScrollController } from "./local-conversation-thread-scroll-controller";
import type { ThreadResponseSpaceController } from "./local-conversation-response-space";
import { subscribeToElementResize } from "../../../lib/resize-observer-motion-values";

const INTERSECTION_THRESHOLDS = Array.from({ length: 101 }, (_, index) => index / 100);

export function LocalConversationResponseSpaceElement({
  controller,
  onReleased,
}: {
  readonly controller: ThreadResponseSpaceController;
  readonly onReleased: () => void;
}) {
  const scroll = useLocalConversationThreadScrollController();
  const { addScrollListener, addUserScrollListener, scrollElement } = scroll;
  const reducedMotion = useResolvedReducedMotion();
  const setElement = controller.setElement;
  const registerElement = useCallback(
    (element: HTMLDivElement | null) => setElement(element),
    [setElement],
  );
  useInsertionEffect(() => {
    controller.updateContext(scroll, reducedMotion, onReleased);
  }, [controller, onReleased, reducedMotion, scroll]);
  useEffect(() => {
    const element = scrollElement;
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
  }, [controller, scrollElement]);
  useEffect(() => controller.cancelPendingUserScrollDecay, [controller]);
  useLayoutEffect(() => {
    const element = scrollElement;
    const spacer = controller.getElement();
    if (!element || !spacer || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(controller.collapseIfHidden, {
      root: element,
      threshold: INTERSECTION_THRESHOLDS,
    });
    observer.observe(spacer);
    return () => observer.disconnect();
  }, [controller, scrollElement]);
  useLayoutEffect(() => {
    const releaseScroll = addScrollListener(controller.handleScroll);
    const releaseUser = addUserScrollListener(controller.handleUserScroll);
    return () => {
      releaseScroll();
      releaseUser();
    };
  }, [controller, addScrollListener, addUserScrollListener]);
  useLayoutEffect(() => {
    const element = scrollElement;
    if (!element) return;
    controller.reconcileViewport();
    let frame: number | null = null;
    const schedule = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        controller.reconcileViewport();
      });
    };
    const footer = element.parentElement?.querySelector("[data-thread-scroll-footer]");
    const elements = footer ? [element, footer] : [element];
    const release = elements.map((target) => subscribeToElementResize(target, schedule));
    window.addEventListener("resize", schedule, { passive: true });
    return () => {
      for (const unsubscribe of release) unsubscribe();
      window.removeEventListener("resize", schedule);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [controller, scrollElement]);
  return <div ref={registerElement} className="shrink-0" aria-hidden="true" />;
}
