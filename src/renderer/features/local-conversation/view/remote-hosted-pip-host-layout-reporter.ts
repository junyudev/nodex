import { useEffect, useEffectEvent, useLayoutEffect, useRef } from "react";
import {
  REMOTE_HOSTED_PIP_ANCHOR_HOST_ATTRIBUTE,
  REMOTE_HOSTED_PIP_HOME_SURFACE_ATTRIBUTE,
  REMOTE_HOSTED_PIP_MAIN_THREAD_HOST_ID,
  REMOTE_HOSTED_PIP_OBSTACLE_ATTRIBUTE,
  buildRemoteHostedPipHiddenHostLayout,
  buildRemoteHostedPipHostLayout,
  serializeRemoteHostedPipHostLayoutIdentity,
  type RemoteHostedPipHostLayout,
  type RemoteHostedPipViewportRect,
} from "../../../../shared/remote-hosted-pip";

const REMOTE_HOSTED_PIP_ANCHOR_SELECTOR = `[${REMOTE_HOSTED_PIP_ANCHOR_HOST_ATTRIBUTE}="${REMOTE_HOSTED_PIP_MAIN_THREAD_HOST_ID}"]`;
const REMOTE_HOSTED_PIP_HOME_SURFACE_SELECTOR = `[${REMOTE_HOSTED_PIP_HOME_SURFACE_ATTRIBUTE}]`;
const REMOTE_HOSTED_PIP_OBSTACLE_SELECTOR = `[${REMOTE_HOSTED_PIP_OBSTACLE_ATTRIBUTE}]`;
const REMOTE_HOSTED_PIP_OBSERVED_SELECTOR = [
  REMOTE_HOSTED_PIP_ANCHOR_SELECTOR,
  REMOTE_HOSTED_PIP_HOME_SURFACE_SELECTOR,
  REMOTE_HOSTED_PIP_OBSTACLE_SELECTOR,
].join(",");

export interface RemoteHostedPipHostLayoutReporterControl {
  setCodexHomeAvailable: (available: boolean) => void;
  stop: () => void;
}

/**
 * Owns the DOM observation lifetime independently from React. Main remains the
 * state owner; this bridge reports only bounded window-relative geometry.
 */
export function createRemoteHostedPipHostLayoutReporter(
  scale = 1,
): RemoteHostedPipHostLayoutReporterControl {
  if (!window.api || document.body === null) return NOOP_REPORTER;

  const effectiveScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  let frameId: number | null = null;
  let isCodexHomeAvailable = false;
  let lastIdentity: string | null = null;
  let lastLayout: RemoteHostedPipHostLayout | null = null;
  let suppressNextAnimation = false;
  const reducedMotion =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : null;
  const resizeObserver = createResizeObserver(() => schedulePublish());
  const observedAttributeObserver = createObservedAttributeObserver(() => schedulePublish());
  const treeObserver = createTreeObserver((records) => {
    if (!records.some(isRemoteHostedPipObservedMutation)) return;

    refreshObservedElements();
    schedulePublish();
  });

  function publishLayout(layout: RemoteHostedPipHostLayout) {
    const identity = serializeRemoteHostedPipHostLayoutIdentity(layout);
    if (identity === lastIdentity) return;

    const publishedLayout = {
      ...layout,
      animated:
        !suppressNextAnimation &&
        reducedMotion?.matches !== true &&
        lastLayout?.anchorRect !== undefined &&
        lastLayout.anchorRect !== null &&
        layout.anchorRect !== null,
    };
    suppressNextAnimation = false;
    lastIdentity = identity;
    lastLayout = publishedLayout;
    void window.api
      ?.invoke("remote-hosted-pip:host-layout:report", publishedLayout)
      .catch(() => undefined);
  }

  function clearLayout() {
    publishLayout(buildRemoteHostedPipHiddenHostLayout());
  }

  function schedulePublish() {
    if (frameId !== null) return;

    frameId = window.requestAnimationFrame(() => {
      frameId = null;
      publishCurrentLayout();
    });
  }

  function publishCurrentLayout() {
    const hostElement = document.querySelector(REMOTE_HOSTED_PIP_ANCHOR_SELECTOR);
    if (!(hostElement instanceof HTMLElement)) {
      clearLayout();
      return;
    }

    const hostRect = readElementViewportRect(hostElement, effectiveScale);
    if (hostRect === null) {
      clearLayout();
      return;
    }

    const obstacleRects = readElementViewportRects(
      REMOTE_HOSTED_PIP_OBSTACLE_SELECTOR,
      effectiveScale,
    );
    const homeSurfaceRect = readFirstElementViewportRect(
      REMOTE_HOSTED_PIP_HOME_SURFACE_SELECTOR,
      effectiveScale,
    );

    publishLayout(
      buildRemoteHostedPipHostLayout({
        homeSurfaceRect,
        hostRect,
        isCodexHomeAvailable,
        obstacleRects,
      }),
    );
  }

  function refreshObservedElements() {
    resizeObserver?.disconnect();
    observedAttributeObserver?.disconnect();

    for (const element of document.querySelectorAll(REMOTE_HOSTED_PIP_OBSERVED_SELECTOR)) {
      resizeObserver?.observe(element);
      observedAttributeObserver?.observe(element, {
        attributeFilter: ["class", "hidden", "style"],
        attributes: true,
      });
    }
  }

  treeObserver?.observe(document.body, {
    attributeFilter: [
      REMOTE_HOSTED_PIP_ANCHOR_HOST_ATTRIBUTE,
      REMOTE_HOSTED_PIP_HOME_SURFACE_ATTRIBUTE,
      REMOTE_HOSTED_PIP_OBSTACLE_ATTRIBUTE,
    ],
    attributes: true,
    childList: true,
    subtree: true,
  });
  const handleReducedMotionChange = () => {
    lastIdentity = null;
    suppressNextAnimation = true;
    schedulePublish();
  };
  reducedMotion?.addEventListener("change", handleReducedMotionChange);
  window.addEventListener("resize", schedulePublish);
  document.addEventListener("scroll", schedulePublish, true);
  refreshObservedElements();
  schedulePublish();

  return {
    setCodexHomeAvailable(available) {
      if (available === isCodexHomeAvailable) return;

      isCodexHomeAvailable = available;
      schedulePublish();
    },
    stop() {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
        frameId = null;
      }
      resizeObserver?.disconnect();
      observedAttributeObserver?.disconnect();
      treeObserver?.disconnect();
      reducedMotion?.removeEventListener("change", handleReducedMotionChange);
      window.removeEventListener("resize", schedulePublish);
      document.removeEventListener("scroll", schedulePublish, true);
      clearLayout();
    },
  };
}

export function RemoteHostedPipHostLayoutReporter({
  isCodexHomeAvailable,
  scale = 1,
}: {
  isCodexHomeAvailable: boolean;
  scale?: number;
}) {
  const reporterRef = useRef<RemoteHostedPipHostLayoutReporterControl | null>(null);
  const updateHomeAvailability = useEffectEvent(
    (reporter: RemoteHostedPipHostLayoutReporterControl) => {
      reporter.setCodexHomeAvailable(isCodexHomeAvailable);
    },
  );

  useEffect(() => {
    const reporter = createRemoteHostedPipHostLayoutReporter(scale);
    reporterRef.current = reporter;
    updateHomeAvailability(reporter);

    return () => {
      reporter.stop();
      if (reporterRef.current === reporter) reporterRef.current = null;
    };
  }, [scale]);

  useLayoutEffect(() => {
    reporterRef.current?.setCodexHomeAvailable(isCodexHomeAvailable);
  }, [isCodexHomeAvailable]);

  return null;
}

function readElementViewportRects(selector: string, scale: number): RemoteHostedPipViewportRect[] {
  return Array.from(document.querySelectorAll(selector)).flatMap((element) => {
    if (!(element instanceof HTMLElement)) return [];

    const rect = readElementViewportRect(element, scale);
    return rect === null ? [] : [rect];
  });
}

function readFirstElementViewportRect(
  selector: string,
  scale: number,
): RemoteHostedPipViewportRect | null {
  for (const element of document.querySelectorAll(selector)) {
    if (!(element instanceof HTMLElement)) continue;

    const rect = readElementViewportRect(element, scale);
    if (rect !== null) return rect;
  }

  return null;
}

function readElementViewportRect(
  element: HTMLElement,
  scale: number,
): RemoteHostedPipViewportRect | null {
  if (element.hidden) return null;

  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;

  return {
    height: rect.height / scale,
    width: rect.width / scale,
    x: rect.left / scale,
    y: rect.top / scale,
  };
}

function isRemoteHostedPipObservedMutation(record: MutationRecord): boolean {
  if (record.type === "attributes") return true;

  for (const node of record.addedNodes) {
    if (containsRemoteHostedPipObservedElement(node)) return true;
  }
  for (const node of record.removedNodes) {
    if (containsRemoteHostedPipObservedElement(node)) return true;
  }

  return false;
}

function containsRemoteHostedPipObservedElement(node: Node): boolean {
  return (
    node instanceof HTMLElement &&
    (node.matches(REMOTE_HOSTED_PIP_OBSERVED_SELECTOR) ||
      node.querySelector(REMOTE_HOSTED_PIP_OBSERVED_SELECTOR) !== null)
  );
}

function createResizeObserver(callback: ResizeObserverCallback): ResizeObserver | null {
  if (typeof ResizeObserver === "undefined") return null;
  return new ResizeObserver(callback);
}

function createObservedAttributeObserver(callback: MutationCallback): MutationObserver | null {
  if (typeof MutationObserver === "undefined") return null;
  return new MutationObserver(callback);
}

function createTreeObserver(callback: MutationCallback): MutationObserver | null {
  if (typeof MutationObserver === "undefined") return null;
  return new MutationObserver(callback);
}

const NOOP_REPORTER: RemoteHostedPipHostLayoutReporterControl = {
  setCodexHomeAvailable: () => undefined,
  stop: () => undefined,
};
