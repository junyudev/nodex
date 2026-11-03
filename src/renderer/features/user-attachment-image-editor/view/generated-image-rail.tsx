import { useCallback, useLayoutEffect, useRef, type WheelEvent } from "react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import { useResolvedImageAsset, type EditableImageDescriptor } from "@/lib/content-image";

import { GeneratedImageDotField } from "./generated-image-dot-field";

const THUMBNAIL_SIZE_PX = 46;
const THUMBNAIL_STRIDE_PX = 54;
const RAIL_PADDING_PX = 6;

function resolveRailScrollTop(
  center: number,
  contentHeight: number,
  element: HTMLDivElement,
): number {
  const halfViewport = Math.min(contentHeight, element.clientHeight) / 2;
  return Math.min(
    Math.max(center - halfViewport, 0),
    Math.max(element.scrollHeight - element.clientHeight, 0),
  );
}

function GeneratedImageRailThumbnail({ image }: { image: EditableImageDescriptor }) {
  const asset = useResolvedImageAsset(image.previewSrc ?? image.src, { allowLocalPath: true });
  const src = asset.previewSrc;
  if (image.loading || asset.isLoading) {
    return (
      <span
        aria-busy="true"
        aria-label="Generating image…"
        className="electron-dark:bg-token-list-hover-background electron-dark:text-white/70 relative size-full overflow-clip rounded-lg bg-token-list-active-selection-background text-token-text-secondary dark:bg-token-list-hover-background dark:text-white/70"
      >
        <GeneratedImageDotField presentation="thumbnail" seed={image.id} />
      </span>
    );
  }
  if (!src) {
    return <span className="size-full rounded-lg bg-token-error-background" />;
  }
  return (
    <img
      alt=""
      className="size-full rounded-lg object-cover"
      decoding="async"
      referrerPolicy={image.referrerPolicy}
      src={src}
    />
  );
}

export interface GeneratedImageRailProps {
  activeId: string;
  autoScrollImageId?: string | null;
  images: readonly EditableImageDescriptor[];
  onSelect: (image: EditableImageDescriptor) => void;
}

export function GeneratedImageRail({
  activeId,
  autoScrollImageId = null,
  images,
  onSelect,
}: GeneratedImageRailProps) {
  const activeIndex = Math.max(
    images.findIndex((image) => image.id === activeId),
    0,
  );
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const autoScrolledImageIdRef = useRef<string | null>(null);
  const virtualCenterRef = useRef(
    RAIL_PADDING_PX + activeIndex * THUMBNAIL_STRIDE_PX + THUMBNAIL_SIZE_PX / 2,
  );
  const contentHeight =
    RAIL_PADDING_PX * 2 + Math.max(images.length - 1, 0) * THUMBNAIL_STRIDE_PX + THUMBNAIL_SIZE_PX;

  const initialMetricsRef = useRef({ activeIndex, contentHeight });
  useLayoutEffect(() => {
    initialMetricsRef.current = { activeIndex, contentHeight };
  }, [activeIndex, contentHeight]);
  const setScrollerRef = useCallback((scroller: HTMLDivElement | null) => {
    if (!scroller) {
      scrollerRef.current = null;
      return;
    }
    if (scrollerRef.current) return;
    const metrics = initialMetricsRef.current;
    const center =
      RAIL_PADDING_PX + metrics.activeIndex * THUMBNAIL_STRIDE_PX + THUMBNAIL_SIZE_PX / 2;
    virtualCenterRef.current = center;
    scroller.scrollTop = resolveRailScrollTop(center, metrics.contentHeight, scroller);
    scrollerRef.current = scroller;
  }, []);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (
      !scroller ||
      autoScrollImageId === null ||
      autoScrollImageId !== activeId ||
      autoScrolledImageIdRef.current === autoScrollImageId
    )
      return;
    autoScrolledImageIdRef.current = autoScrollImageId;
    const center =
      RAIL_PADDING_PX +
      Math.max(images.length - 1, 0) * THUMBNAIL_STRIDE_PX +
      THUMBNAIL_SIZE_PX / 2;
    virtualCenterRef.current = center;
    scroller.scrollTo({ top: scroller.scrollHeight });
  }, [activeId, autoScrollImageId, images.length]);

  const selectIndex = (index: number) => {
    const image = images[index];
    if (!image) return;
    const center = RAIL_PADDING_PX + index * THUMBNAIL_STRIDE_PX + THUMBNAIL_SIZE_PX / 2;
    virtualCenterRef.current = center;
    onSelect(image);
    const scroller = scrollerRef.current;
    scroller?.scrollTo({
      top: scroller ? resolveRailScrollTop(center, contentHeight, scroller) : 0,
    });
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (event.ctrlKey) return;
    event.preventDefault();
    const pixels =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? event.deltaY * 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? event.deltaY * event.currentTarget.clientHeight
          : event.deltaY;
    const maxCenter =
      RAIL_PADDING_PX +
      Math.max(images.length - 1, 0) * THUMBNAIL_STRIDE_PX +
      THUMBNAIL_SIZE_PX / 2;
    const center = Math.min(
      Math.max(virtualCenterRef.current + pixels, THUMBNAIL_SIZE_PX / 2 + RAIL_PADDING_PX),
      maxCenter,
    );
    virtualCenterRef.current = center;
    event.currentTarget.scrollTop = resolveRailScrollTop(
      center,
      contentHeight,
      event.currentTarget,
    );
    const index = Math.round(
      (center - RAIL_PADDING_PX - THUMBNAIL_SIZE_PX / 2) / THUMBNAIL_STRIDE_PX,
    );
    const image = images[index];
    if (image && image.id !== activeId) onSelect(image);
  };

  return (
    <div
      ref={setScrollerRef}
      aria-label="Generated images"
      className="mt-10 w-18 shrink-0 overflow-y-auto py-1.5 ps-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      onWheel={handleWheel}
    >
      {images.map((image, index) => {
        const active = image.id === activeId;
        return (
          <motion.button
            key={image.id}
            type="button"
            animate={{
              opacity: active ? 1 : 0.34,
              scale: active ? 1.2 : 0.95,
            }}
            aria-current={active ? "true" : undefined}
            aria-label={image.loading ? "Generating image…" : image.alt}
            className={cn(
              "mx-auto mb-2 flex cursor-interaction overflow-hidden rounded-lg border border-token-border focus:outline-none focus-visible:ring-1 focus-visible:ring-token-foreground focus-visible:ring-offset-1",
              !image.loading && "bg-token-bg-tertiary",
            )}
            style={{ height: THUMBNAIL_SIZE_PX, width: THUMBNAIL_SIZE_PX }}
            transition={{ duration: 0.12 }}
            onClick={() => selectIndex(index)}
            onKeyDown={(event) => {
              const delta =
                event.key === "ArrowUp" || event.key === "ArrowLeft"
                  ? -1
                  : Number(event.key === "ArrowDown" || event.key === "ArrowRight");
              if (delta === 0) return;
              event.preventDefault();
              selectIndex(activeIndex + delta);
            }}
          >
            <GeneratedImageRailThumbnail image={image} />
          </motion.button>
        );
      })}
      <div style={{ height: `calc(50% - ${THUMBNAIL_SIZE_PX / 2}px)` }} />
    </div>
  );
}
