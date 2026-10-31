import { flushSync } from "react-dom";
import {
  useEffect,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from "react";
import { cn } from "@/lib/utils";
import {
  computeFitZoomPercent,
  computeManualImageSize,
  computeZoomAnchorCorrection,
  computeZoomViewportCenter,
} from "../model/image-geometry";
import { readImageEditorWindowZoom } from "../model/generated-image-view-transition";
import type { ImageReferrerPolicy } from "@/lib/content-image";
import type { ImageSize } from "../model/types";
import { ImageZoomControl } from "./image-zoom-control";

const IMAGE_RAIL_WIDTH_PX = 72;
const IMAGE_RAIL_INLINE_GUTTER_PX = 8;
const IMAGE_ZOOM_MIN_PERCENT = 10;
const IMAGE_ZOOM_MAX_PERCENT = 400;
const IMAGE_ZOOM_WHEEL_EXPONENT = 0.01;
const PINCH_CLICK_SUPPRESSION_MS = 500;

interface PanSample {
  clientX: number;
  clientY: number;
  pointerId: number;
  scrollLeft: number;
  scrollTop: number;
}

interface PinchSample {
  distance: number;
  zoomPercent: number;
}

interface ViewportPoint {
  clientX: number;
  clientY: number;
}

export interface ImageZoomViewerProps {
  alt: string;
  hasImageRail?: boolean;
  imageRef?: Ref<HTMLImageElement>;
  manualZoomPercent: number | null;
  referrerPolicy?: ImageReferrerPolicy;
  src: string;
  trailingControls?: ReactNode;
  onManualZoomPercentChange: (zoomPercent: number | null) => void;
}

function clampZoomPercent(value: number): number {
  return Math.min(IMAGE_ZOOM_MAX_PERCENT, Math.max(IMAGE_ZOOM_MIN_PERCENT, Math.round(value)));
}

function zoomFromWheel(currentZoomPercent: number, deltaY: number): number {
  return clampZoomPercent(currentZoomPercent * Math.exp(-deltaY * IMAGE_ZOOM_WHEEL_EXPONENT));
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  if (ref) ref.current = value;
}

function pointerDistance(firstX: number, firstY: number, secondX: number, secondY: number): number {
  return Math.hypot(firstX - secondX, firstY - secondY);
}

export function ImageZoomViewer({
  alt,
  hasImageRail = false,
  imageRef,
  manualZoomPercent,
  referrerPolicy,
  src,
  trailingControls,
  onManualZoomPercentChange,
}: ImageZoomViewerProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const imageElementRef = useRef<HTMLImageElement | null>(null);
  const panRef = useRef<PanSample | null>(null);
  const pinchRef = useRef<PinchSample | null>(null);
  const lastPointerPointRef = useRef<ViewportPoint | null>(null);
  const lastPinchEndAtRef = useRef(0);
  const userPositionedRef = useRef(false);
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const [naturalImageSize, setNaturalImageSize] = useState<ImageSize | null>(null);
  const [viewportSize, setViewportSize] = useState<ImageSize | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const railReservePx = hasImageRail ? IMAGE_RAIL_WIDTH_PX : 0;
  const inlineReservePx = railReservePx + IMAGE_RAIL_INLINE_GUTTER_PX * 2;
  const fitZoomPercent = computeFitZoomPercent({
    naturalImageSize,
    viewportSize:
      viewportSize === null
        ? null
        : {
            height: viewportSize.height,
            width: Math.max(viewportSize.width - inlineReservePx, 1),
          },
  });
  const resolvedZoomPercent = manualZoomPercent ?? fitZoomPercent ?? 100;
  const imageSize =
    manualZoomPercent === null && fitZoomPercent === null
      ? null
      : computeManualImageSize({
          naturalImageSize,
          zoomPercent: manualZoomPercent ?? fitZoomPercent ?? 100,
        });
  const contentSize =
    viewportSize === null
      ? null
      : {
          height: Math.max(viewportSize.height, imageSize?.height ?? viewportSize.height),
          width: Math.max(viewportSize.width, (imageSize?.width ?? 0) + inlineReservePx),
        };
  const imageOverflows =
    imageSize !== null &&
    viewportSize !== null &&
    (imageSize.height > viewportSize.height ||
      imageSize.width + inlineReservePx > viewportSize.width);

  const updateViewportSize = useCallback((element: HTMLDivElement) => {
    const nextSize = { height: element.clientHeight, width: element.clientWidth };
    if (nextSize.height <= 0 || nextSize.width <= 0) return;
    setViewportSize((current) =>
      current?.height === nextSize.height && current.width === nextSize.width ? current : nextSize,
    );
  }, []);

  useEffect(() => {
    if (!scrollElement || typeof ResizeObserver === "undefined") return undefined;
    updateViewportSize(scrollElement);
    const observer = new ResizeObserver(() => updateViewportSize(scrollElement));
    observer.observe(scrollElement);
    return () => observer.disconnect();
  }, [scrollElement, updateViewportSize]);

  const viewportCenter = useCallback(
    (element: HTMLDivElement): ViewportPoint => {
      const rect = element.getBoundingClientRect();
      const center = computeZoomViewportCenter({
        direction: getComputedStyle(element).direction === "rtl" ? "rtl" : "ltr",
        inlineOffset: -railReservePx / 2,
        viewportRect: rect,
        windowZoom: readImageEditorWindowZoom(element),
      });
      return { clientX: center.x, clientY: center.y };
    },
    [railReservePx],
  );

  const setZoomAtPoint = useCallback(
    (nextZoomPercent: number, point: ViewportPoint) => {
      const scroller = scrollRef.current;
      const image = imageElementRef.current;
      if (!scroller || !image) {
        onManualZoomPercentChange(nextZoomPercent);
        return;
      }

      const before = image.getBoundingClientRect();
      const relativeX =
        before.width > 0
          ? Math.min(1, Math.max(0, (point.clientX - before.left) / before.width))
          : 0.5;
      const relativeY =
        before.height > 0
          ? Math.min(1, Math.max(0, (point.clientY - before.top) / before.height))
          : 0.5;
      userPositionedRef.current = true;
      flushSync(() => onManualZoomPercentChange(clampZoomPercent(nextZoomPercent)));
      if (!scroller.isConnected || !image.isConnected) return;
      const after = image.getBoundingClientRect();
      const correction = computeZoomAnchorCorrection({
        anchorClientPoint: { x: point.clientX, y: point.clientY },
        anchorRatio: { x: relativeX, y: relativeY },
        nextTargetRect: after,
        windowZoom: readImageEditorWindowZoom(image),
      });
      scroller.scrollLeft += correction.x;
      scroller.scrollTop += correction.y;
    },
    [onManualZoomPercentChange],
  );

  useEffect(() => {
    if (!scrollElement) return undefined;

    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
      const nextZoomPercent = zoomFromWheel(resolvedZoomPercent, event.deltaY);
      if (nextZoomPercent === resolvedZoomPercent) return;
      const point =
        event.clientX === 0 && event.clientY === 0
          ? (lastPointerPointRef.current ?? viewportCenter(scrollElement))
          : { clientX: event.clientX, clientY: event.clientY };
      setZoomAtPoint(nextZoomPercent, point);
    };

    const endPinch = (event: TouchEvent) => {
      if (pinchRef.current) lastPinchEndAtRef.current = event.timeStamp;
      pinchRef.current = null;
    };

    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 2) {
        pinchRef.current = null;
        return;
      }
      event.preventDefault();
      const first = event.touches.item(0);
      const second = event.touches.item(1);
      if (!first || !second) return;
      pinchRef.current = {
        distance: pointerDistance(first.clientX, first.clientY, second.clientX, second.clientY),
        zoomPercent: resolvedZoomPercent,
      };
    };

    const handleTouchMove = (event: TouchEvent) => {
      const pinch = pinchRef.current;
      if (event.touches.length !== 2 || !pinch) return;
      event.preventDefault();
      event.stopPropagation();
      const first = event.touches.item(0);
      const second = event.touches.item(1);
      if (!first || !second) return;
      const distance = pointerDistance(
        first.clientX,
        first.clientY,
        second.clientX,
        second.clientY,
      );
      if (distance <= 0 || pinch.distance <= 0) return;
      const nextZoomPercent = clampZoomPercent((distance / pinch.distance) * pinch.zoomPercent);
      if (nextZoomPercent === resolvedZoomPercent) return;
      setZoomAtPoint(nextZoomPercent, {
        clientX: (first.clientX + second.clientX) / 2,
        clientY: (first.clientY + second.clientY) / 2,
      });
    };

    scrollElement.addEventListener("wheel", handleWheel, { passive: false });
    scrollElement.addEventListener("touchstart", handleTouchStart, { passive: false });
    scrollElement.addEventListener("touchmove", handleTouchMove, { passive: false });
    scrollElement.addEventListener("touchend", endPinch);
    scrollElement.addEventListener("touchcancel", endPinch);
    return () => {
      scrollElement.removeEventListener("wheel", handleWheel);
      scrollElement.removeEventListener("touchstart", handleTouchStart);
      scrollElement.removeEventListener("touchmove", handleTouchMove);
      scrollElement.removeEventListener("touchend", endPinch);
      scrollElement.removeEventListener("touchcancel", endPinch);
    };
  }, [resolvedZoomPercent, scrollElement, setZoomAtPoint, viewportCenter]);

  const setScrollRef = useCallback(
    (element: HTMLDivElement | null) => {
      scrollRef.current = element;
      setScrollElement(element);
      if (element) updateViewportSize(element);
    },
    [updateViewportSize],
  );

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (
      userPositionedRef.current ||
      manualZoomPercent === null ||
      !scroller ||
      !imageSize ||
      !imageOverflows
    )
      return;
    userPositionedRef.current = true;
    scroller.scrollLeft = Math.max((scroller.scrollWidth - scroller.clientWidth) / 2, 0);
    scroller.scrollTop = Math.max((scroller.scrollHeight - scroller.clientHeight) / 2, 0);
  }, [imageOverflows, imageSize, manualZoomPercent]);

  const finishPan = (event: ReactPointerEvent<HTMLImageElement>) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    panRef.current = null;
    setIsPanning(false);
    if (
      typeof event.currentTarget.hasPointerCapture === "function" &&
      event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <>
      <div className="absolute top-2 right-2 z-40 flex h-8 items-center gap-1">
        <ImageZoomControl
          fitSelected={manualZoomPercent === null}
          zoomPercent={Math.round(resolvedZoomPercent)}
          onZoomPercentChange={(nextZoomPercent) => {
            const scroller = scrollRef.current;
            if (!scroller) {
              onManualZoomPercentChange(nextZoomPercent);
              return;
            }
            setZoomAtPoint(nextZoomPercent, viewportCenter(scroller));
          }}
          onZoomToFit={() => {
            userPositionedRef.current = false;
            onManualZoomPercentChange(null);
            if (scrollRef.current) {
              scrollRef.current.scrollLeft = 0;
              scrollRef.current.scrollTop = 0;
            }
          }}
        />
        {trailingControls}
      </div>
      <div className={cn("min-h-0 min-w-0 flex-1 py-4", hasImageRail && "-me-18")}>
        <div
          ref={setScrollRef}
          className={cn(
            "h-full min-h-0 w-full min-w-0",
            manualZoomPercent !== null && imageOverflows ? "overflow-auto" : "overflow-hidden",
          )}
          onClickCapture={(event) => {
            if (
              lastPinchEndAtRef.current !== 0 &&
              event.timeStamp - lastPinchEndAtRef.current < PINCH_CLICK_SUPPRESSION_MS
            ) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
          onPointerMoveCapture={(event) => {
            lastPointerPointRef.current = { clientX: event.clientX, clientY: event.clientY };
            if (event.pointerType === "touch" && pinchRef.current) event.stopPropagation();
          }}
        >
          <div
            className={cn(
              "flex items-center justify-center px-2",
              hasImageRail && "pe-20",
              contentSize === null && "h-full w-full",
              contentSize !== null && "shrink-0",
            )}
            style={contentSize ?? undefined}
          >
            <img
              ref={(element) => {
                imageElementRef.current = element;
                assignRef(imageRef, element);
              }}
              alt={alt}
              className={cn(
                "block shrink-0 rounded-xl object-contain",
                imageSize === null ? "max-h-full max-w-full" : "max-w-none",
                imageOverflows && (isPanning ? "cursor-grabbing" : "cursor-grab"),
              )}
              draggable={false}
              referrerPolicy={referrerPolicy}
              src={src}
              style={
                imageSize === null
                  ? undefined
                  : { height: imageSize.height, width: imageSize.width }
              }
              onLoad={(event) => {
                const { naturalHeight, naturalWidth } = event.currentTarget;
                if (naturalHeight <= 0 || naturalWidth <= 0) return;
                setNaturalImageSize({ height: naturalHeight, width: naturalWidth });
              }}
              onPointerDown={(event) => {
                const scroller = scrollRef.current;
                if (
                  !imageOverflows ||
                  !scroller ||
                  event.pointerType === "touch" ||
                  event.button !== 0
                )
                  return;
                event.preventDefault();
                panRef.current = {
                  clientX: event.clientX,
                  clientY: event.clientY,
                  pointerId: event.pointerId,
                  scrollLeft: scroller.scrollLeft,
                  scrollTop: scroller.scrollTop,
                };
                setIsPanning(true);
                event.currentTarget.setPointerCapture?.(event.pointerId);
              }}
              onPointerMove={(event) => {
                const pan = panRef.current;
                const scroller = scrollRef.current;
                if (!pan || !scroller || pan.pointerId !== event.pointerId) return;
                event.preventDefault();
                const windowZoom = readImageEditorWindowZoom(scroller);
                scroller.scrollLeft = pan.scrollLeft - (event.clientX - pan.clientX) / windowZoom;
                scroller.scrollTop = pan.scrollTop - (event.clientY - pan.clientY) / windowZoom;
              }}
              onPointerUp={finishPan}
              onPointerCancel={finishPan}
              onLostPointerCapture={finishPan}
            />
          </div>
        </div>
      </div>
    </>
  );
}
