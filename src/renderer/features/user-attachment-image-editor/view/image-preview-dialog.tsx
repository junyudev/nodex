import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import {
  BrowserBackIcon,
  ImageZoomMinusIcon,
  DownloadIcon,
  EditIcon,
  LoadingIcon,
  PlusIcon,
} from "@/components/shared/icons";
import {
  NodexDialog,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { trackImageView, type ImageViewAnalytics } from "../analytics/image-editor-analytics";
import { useResolvedImageAsset } from "../adapters/use-resolved-image-asset";
import {
  createImageDownloadFilename,
  downloadImageDataUrl,
} from "../adapters/resolved-image-asset";
import { computeFitZoomPercent, computeManualImageSize } from "../model/image-geometry";
import type { ImageSize } from "../model/types";

const ZOOM_RAMP = [
  25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500,
] as const;

export interface ImagePreviewDialogProps {
  analytics?: ImageViewAnalytics;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  src: string;
  downloadSrc?: string;
  downloadFileName?: string;
  alt?: string;
  referrerPolicy?: React.ImgHTMLAttributes<HTMLImageElement>["referrerPolicy"];
  onPreviousImage?: () => void;
  onNextImage?: () => void;
  onEditImage?: () => void;
  allowLocalPath?: boolean;
  showZoomControls?: boolean;
  closeOnSpace?: boolean;
  finalFocus?: React.ComponentProps<typeof NodexDialogContent>["finalFocus"];
}

function nextZoom(currentZoom: number, direction: "in" | "out"): number {
  if (direction === "in") {
    return ZOOM_RAMP.find((value) => value > currentZoom) ?? ZOOM_RAMP.at(-1) ?? currentZoom;
  }
  return [...ZOOM_RAMP].reverse().find((value) => value < currentZoom) ?? ZOOM_RAMP[0];
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.closest("input, textarea, select, [contenteditable='true']") !== null
  );
}

export function ImagePreviewDialog({
  analytics,
  open,
  onOpenChange,
  src,
  downloadSrc = src,
  downloadFileName,
  alt = "User attachment",
  referrerPolicy = "no-referrer",
  onPreviousImage,
  onNextImage,
  onEditImage,
  allowLocalPath = false,
  showZoomControls = true,
  closeOnSpace = false,
  finalFocus,
}: ImagePreviewDialogProps) {
  const previewAsset = useResolvedImageAsset(src, { allowLocalPath });
  const downloadAsset = useResolvedImageAsset(downloadSrc, { allowLocalPath });
  const [manualZoomPercent, setManualZoomPercent] = useState<number | null>(null);
  const [naturalImageSize, setNaturalImageSize] = useState<ImageSize | null>(null);
  const [viewportSize, setViewportSize] = useState<ImageSize | null>(null);
  const [viewportNode, setViewportNode] = useState<HTMLDivElement | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const analyticsAvailableImageCount = analytics?.availableImageCount;
  const analyticsEntrypoint = analytics?.entrypoint;
  const analyticsImageSource = analytics?.imageSource;
  const panStateRef = useRef<{
    pointerId: number;
    clientX: number;
    clientY: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);

  const displaySrc = previewAsset.previewSrc ?? src;
  const hasNavigation = onPreviousImage !== undefined || onNextImage !== undefined;
  const fitZoomPercent = computeFitZoomPercent({ naturalImageSize, viewportSize });
  const zoomPercent = manualZoomPercent ?? fitZoomPercent ?? 100;
  const imageSize = computeManualImageSize({ naturalImageSize, zoomPercent });
  const zoomRamp =
    fitZoomPercent === null || ZOOM_RAMP.some((value) => value === fitZoomPercent)
      ? ZOOM_RAMP
      : [...ZOOM_RAMP, fitZoomPercent].sort((left, right) => left - right);
  const minimumZoom = zoomRamp[0] ?? zoomPercent;
  const maximumZoom = zoomRamp.at(-1) ?? zoomPercent;
  const canZoomOut = zoomPercent > minimumZoom;
  const canZoomIn = zoomPercent < maximumZoom;
  const imageOverflows =
    imageSize !== null &&
    viewportSize !== null &&
    (imageSize.width > viewportSize.width || imageSize.height > viewportSize.height);

  useEffect(() => {
    if (!open) return;
    setManualZoomPercent(null);
    setNaturalImageSize(null);
    setLoadFailed(false);
  }, [open, src]);

  useEffect(() => {
    if (
      !open ||
      analyticsAvailableImageCount === undefined ||
      analyticsEntrypoint === undefined ||
      analyticsImageSource === undefined
    )
      return;
    trackImageView({
      availableImageCount: analyticsAvailableImageCount,
      entrypoint: analyticsEntrypoint,
      imageSource: analyticsImageSource,
      view: "preview_dialog",
    });
  }, [analyticsAvailableImageCount, analyticsEntrypoint, analyticsImageSource, open]);

  useEffect(() => {
    if (!open) return;
    if (viewportNode) {
      viewportNode.scrollLeft = 0;
      viewportNode.scrollTop = 0;
    }
  }, [open, src, viewportNode]);

  useEffect(() => {
    if (!viewportNode) return;
    const updateSize = () => {
      const width = viewportNode.clientWidth;
      const height = viewportNode.clientHeight;
      if (width <= 0 || height <= 0) return;
      setViewportSize((current) =>
        current?.width === width && current.height === height ? current : { width, height },
      );
    };
    updateSize();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateSize);
    observer.observe(viewportNode);
    return () => observer.disconnect();
  }, [viewportNode]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditableTarget(event.target)) return;
      if (event.key === "ArrowLeft" && onPreviousImage) {
        event.preventDefault();
        event.stopPropagation();
        onPreviousImage();
        return;
      }
      if (event.key === "ArrowRight" && onNextImage) {
        event.preventDefault();
        event.stopPropagation();
        onNextImage();
        return;
      }
      if (
        closeOnSpace &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        (event.code === "Space" || event.key === " " || event.key === "Spacebar")
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) onOpenChange(false);
        return;
      }
      if (!showZoomControls || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        setManualZoomPercent(nextZoom(zoomPercent, "in"));
        return;
      }
      if (event.key === "-") {
        event.preventDefault();
        setManualZoomPercent(nextZoom(zoomPercent, "out"));
        return;
      }
      if (event.key === "0") {
        event.preventDefault();
        setManualZoomPercent(null);
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [
    closeOnSpace,
    onNextImage,
    onOpenChange,
    onPreviousImage,
    open,
    showZoomControls,
    zoomPercent,
  ]);

  const handleDownload = async () => {
    if (isDownloading) return;
    setIsDownloading(true);
    try {
      const dataUrl = await downloadAsset.materialize();
      downloadImageDataUrl(dataUrl, createImageDownloadFilename(downloadSrc, downloadFileName));
    } catch {
      toast.danger("Could not download image");
    } finally {
      setIsDownloading(false);
    }
  };

  const handlePanStart = (event: PointerEvent<HTMLImageElement>) => {
    if (event.pointerType === "touch" || !imageOverflows || !viewportNode) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    panStateRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      scrollLeft: viewportNode.scrollLeft,
      scrollTop: viewportNode.scrollTop,
    };
  };

  const handlePanMove = (event: PointerEvent<HTMLImageElement>) => {
    const pan = panStateRef.current;
    if (!pan || !viewportNode || pan.pointerId !== event.pointerId) return;
    event.preventDefault();
    viewportNode.scrollLeft = pan.scrollLeft - (event.clientX - pan.clientX);
    viewportNode.scrollTop = pan.scrollTop - (event.clientY - pan.clientY);
  };

  const handlePanEnd = (event: PointerEvent<HTMLImageElement>) => {
    const pan = panStateRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    panStateRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
  };

  const handleDismiss = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onOpenChange(false);
  };

  const controlClassName =
    "pointer-events-auto flex size-10 cursor-interaction items-center justify-center rounded-full bg-token-editor-background/95 text-token-foreground shadow-md ring-1 ring-black/5 backdrop-blur-sm transition-transform hover:bg-token-menu-background hover:ring-token-focus-border focus:outline-none focus-visible:ring-1 focus-visible:ring-token-focus-border active:scale-95 disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <NodexDialog open={open} onOpenChange={onOpenChange}>
      <NodexDialogContent
        unstyledContent
        showCloseButton
        closeButtonAriaLabel="Close image preview"
        closeButtonClassName="pointer-events-auto top-3 right-3 z-20 flex size-10 items-center justify-center rounded-full bg-token-editor-background/95 p-0 text-token-foreground shadow-md ring-1 ring-black/5 backdrop-blur-sm transition-transform hover:bg-token-menu-background hover:ring-token-focus-border active:scale-95"
        closeIconClassName="icon-sm"
        aria-label="Image preview"
        aria-describedby={undefined}
        overlayClassName="!bg-black/90"
        className="pointer-events-none inset-0 top-0 left-0 h-[100dvh] w-screen max-w-none translate-x-0 translate-y-0 overflow-visible rounded-none bg-transparent p-0 shadow-none ring-0 backdrop-blur-none"
        finalFocus={finalFocus}
      >
        <NodexDialogTitle className="sr-only">Image preview</NodexDialogTitle>
        <NodexDialogDescription className="sr-only">
          Preview of the selected image.
        </NodexDialogDescription>

        <div
          className={cn(
            "pointer-events-auto relative flex size-full flex-col items-center justify-center pt-12 pb-8",
            hasNavigation ? "px-16 sm:px-20" : "px-4 sm:px-8",
          )}
          onClick={handleDismiss}
        >
          <div className="absolute top-3 right-[60px] z-10 flex items-center gap-2">
            {onEditImage ? (
              <button
                type="button"
                className={controlClassName}
                aria-label="Edit image"
                onClick={() => {
                  onEditImage();
                  onOpenChange(false);
                }}
              >
                <EditIcon className="icon-xs" />
              </button>
            ) : null}
            <button
              type="button"
              className={controlClassName}
              aria-label="Download image"
              disabled={isDownloading}
              onClick={() => void handleDownload()}
            >
              {isDownloading ? (
                <LoadingIcon className="icon-xs animate-spin" aria-hidden="true" />
              ) : (
                <DownloadIcon className="icon-xs" />
              )}
            </button>
          </div>

          {onPreviousImage ? (
            <button
              type="button"
              className={cn(controlClassName, "absolute top-1/2 left-3 z-10 -translate-y-1/2")}
              aria-label="Previous image"
              onClick={onPreviousImage}
            >
              <BrowserBackIcon className="icon-sm" />
            </button>
          ) : null}
          {onNextImage ? (
            <button
              type="button"
              className={cn(controlClassName, "absolute top-1/2 right-3 z-10 -translate-y-1/2")}
              aria-label="Next image"
              onClick={onNextImage}
            >
              <BrowserBackIcon className="icon-sm rotate-180" />
            </button>
          ) : null}

          <div
            ref={setViewportNode}
            data-testid="image-preview-dismiss-area"
            className="flex min-h-0 w-full flex-1 items-start justify-start overflow-auto"
            onClick={handleDismiss}
          >
            {previewAsset.isLoading ? (
              <div className="m-auto flex items-center gap-2 text-sm text-white/70" role="status">
                <LoadingIcon className="icon-xs animate-spin" aria-hidden="true" />
                Loading image…
              </div>
            ) : previewAsset.isError || loadFailed ? (
              <div
                className="m-auto flex flex-col items-center gap-3 text-sm text-white/70"
                role="alert"
              >
                <span>Image unavailable</span>
                <button
                  type="button"
                  className="rounded-full bg-white/10 px-3 py-1.5 text-white hover:bg-white/15 focus-visible:ring-1 focus-visible:ring-white focus-visible:outline-none"
                  onClick={() => {
                    setLoadFailed(false);
                    void previewAsset.refetch();
                  }}
                >
                  Try again
                </button>
              </div>
            ) : (
              <img
                src={displaySrc}
                alt={alt}
                draggable={false}
                referrerPolicy={referrerPolicy}
                className={cn(
                  "m-auto block max-w-none rounded-lg object-contain select-none",
                  imageOverflows ? "cursor-grab active:cursor-grabbing" : "max-h-full max-w-full",
                )}
                style={
                  imageSize === null
                    ? undefined
                    : {
                        height: imageSize.height,
                        width: imageSize.width,
                      }
                }
                onError={() => setLoadFailed(true)}
                onLoad={(event) => {
                  const { naturalHeight, naturalWidth } = event.currentTarget;
                  if (naturalHeight <= 0 || naturalWidth <= 0) return;
                  setNaturalImageSize({ height: naturalHeight, width: naturalWidth });
                }}
                onPointerDown={handlePanStart}
                onPointerMove={handlePanMove}
                onPointerUp={handlePanEnd}
                onPointerCancel={handlePanEnd}
                onClick={(event) => event.stopPropagation()}
              />
            )}
          </div>

          {showZoomControls ? (
            <div className="pointer-events-auto z-10 mt-5 flex items-center gap-1 rounded-full bg-token-editor-background/95 p-1 text-token-foreground shadow-md ring-1 ring-black/5 backdrop-blur-sm">
              <button
                type="button"
                className="flex size-9 cursor-interaction items-center justify-center rounded-full bg-token-foreground/10 focus:outline-none focus-visible:ring-1 focus-visible:ring-token-focus-border disabled:cursor-not-allowed disabled:opacity-50"
                aria-label="Zoom out image"
                disabled={!canZoomOut}
                onClick={() => setManualZoomPercent(nextZoom(zoomPercent, "out"))}
              >
                <ImageZoomMinusIcon />
              </button>
              <div className="flex min-w-16 items-center justify-center px-2 text-center text-sm tabular-nums no-drag">
                <span>{`${Math.round(zoomPercent)}%`}</span>
              </div>
              <button
                type="button"
                className="flex size-9 cursor-interaction items-center justify-center rounded-full bg-token-foreground/10 focus:outline-none focus-visible:ring-1 focus-visible:ring-token-focus-border disabled:cursor-not-allowed disabled:opacity-50"
                aria-label="Zoom in image"
                disabled={!canZoomIn}
                onClick={() => setManualZoomPercent(nextZoom(zoomPercent, "in"))}
              >
                <PlusIcon className="icon-xs" aria-hidden="true" />
              </button>
            </div>
          ) : null}
        </div>
      </NodexDialogContent>
    </NodexDialog>
  );
}
