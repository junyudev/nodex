import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import type {
  BrowserSidebarTabIdentity,
  BrowserUseCursorState,
} from "../../../shared/browser-sidebar";
import {
  createBrowserAgentCursorController,
  type BrowserAgentCursorController,
} from "./browser-agent-cursor";
import { browserSidebarRendererWebviewManager } from "./browser-sidebar-webview-manager";

interface BrowserUseCursorOverlayProps {
  cursor: BrowserUseCursorState | null;
  isVisible?: boolean;
  onArrived?: (moveSequence: number) => void;
  turnKey: string;
  viewportSize: {
    height: number;
    width: number;
  };
}

interface CursorSurfaceSize {
  height: number;
  width: number;
}

export function BrowserUseCursorPortal({
  cursor,
  fallbackViewportSize,
  identity,
  isVisible,
  onArrived,
}: {
  cursor: BrowserUseCursorState | null;
  fallbackViewportSize: CursorSurfaceSize | null;
  identity: BrowserSidebarTabIdentity;
  isVisible: boolean;
  onArrived?: (moveSequence: number) => void;
}) {
  const overlayHost = useSyncExternalStore(
    browserSidebarRendererWebviewManager.subscribeCursorOverlayHosts,
    () => browserSidebarRendererWebviewManager.getCursorOverlayHost(identity),
    () => null,
  );
  const presentationSize = useCursorPresentationSize(overlayHost);
  const viewportSize = presentationSize ?? fallbackViewportSize;
  if (!overlayHost || !viewportSize) return null;

  return createPortal(
    <BrowserUseCursorOverlay
      cursor={cursor}
      isVisible={isVisible}
      onArrived={onArrived}
      turnKey={`${identity.browserConversationId}:${isVisible ? "active" : "inactive"}`}
      viewportSize={viewportSize}
    />,
    overlayHost,
  );
}

function useCursorPresentationSize(overlayHost: HTMLElement | null): CursorSurfaceSize | null {
  const [observed, setObserved] = useState<{
    host: HTMLElement;
    size: CursorSurfaceSize | null;
  } | null>(null);
  const size =
    observed?.host === overlayHost ? observed.size : readCursorPresentationSize(overlayHost);

  useLayoutEffect(() => {
    if (!overlayHost) return undefined;
    const update = () => {
      const next = readCursorPresentationSize(overlayHost);
      setObserved((current) => {
        if (
          current?.host === overlayHost &&
          current.size?.height === next?.height &&
          current.size?.width === next?.width
        ) {
          return current;
        }
        return { host: overlayHost, size: next };
      });
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(overlayHost);
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [overlayHost]);

  return size;
}

export function readCursorPresentationSize(
  overlayHost: HTMLElement | null,
): CursorSurfaceSize | null {
  if (!overlayHost) return null;
  const rect = overlayHost.getBoundingClientRect();
  const parent = overlayHost.parentElement;
  const parentRect = parent?.getBoundingClientRect();
  const width = firstPositiveFinite(
    rect.width,
    parentRect?.width,
    readPixelSize(parent?.style.width),
  );
  const height = firstPositiveFinite(
    rect.height,
    parentRect?.height,
    readPixelSize(parent?.style.height),
  );
  if (width === null || height === null) return null;
  return { width, height };
}

function firstPositiveFinite(...values: Array<number | undefined>): number | null {
  return (
    values.find((value) => typeof value === "number" && Number.isFinite(value) && value > 1) ?? null
  );
}

function readPixelSize(value: string | undefined): number | undefined {
  if (!value?.endsWith("px")) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function BrowserUseCursorOverlay({
  cursor,
  isVisible = true,
  onArrived,
  turnKey,
  viewportSize,
}: BrowserUseCursorOverlayProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<BrowserAgentCursorController | null>(null);
  const notifyArrived = useEffectEvent((moveSequence: number) => onArrived?.(moveSequence));

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const controller = createBrowserAgentCursorController(host, {
      onArrived: (moveSequence) => notifyArrived(moveSequence),
    });
    controllerRef.current = controller;
    return () => {
      controllerRef.current = null;
      controller.destroy();
    };
  }, []);

  useEffect(() => {
    controllerRef.current?.setState({
      cursor,
      isVisible,
      turnKey,
      viewportSize,
    });
  }, [cursor, isVisible, turnKey, viewportSize]);

  return (
    <div
      ref={hostRef}
      className="pointer-events-none absolute inset-0 z-20 overflow-hidden"
      data-testid="browser-agent-cursor-overlay"
    />
  );
}
