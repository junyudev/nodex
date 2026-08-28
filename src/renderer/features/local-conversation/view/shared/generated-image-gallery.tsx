import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
} from "react";
import { ChevronLeft } from "@/components/shared/icons/generic-icons";
import {
  areGeneratedImageLiveGroupsEqual,
  GeneratedImagePlaceholder,
  getGeneratedImageLiveCollectionSnapshot,
  ImagePreviewDialog,
  openUserAttachmentImagePreview,
  projectGeneratedImageCanonicalGroups,
  replaceGeneratedImageCanonicalGroups,
  replaceGeneratedImageLiveGroup,
  subscribeGeneratedImageLiveCollections,
  type GeneratedImageDescriptor,
} from "@/features/user-attachment-image-editor";
import {
  ChevronRightIcon,
  EditIcon,
  ImageCanvasViewIcon,
  ImageMultiSelectIcon,
} from "@/components/shared/icons";
import { cn } from "../../../../lib/utils";
import type { ThreadGeneratedImageGalleryItemModel } from "../../thread-stage-types";
import { useCodexConversationValue } from "../../local-conversation-store";
import { calculateGeneratedImageGalleryLayout } from "../../projection/generated-image-gallery-layout";
import { useConversationImageAssetContext } from "../conversation-image-asset-context";
import { useConversationImageAsset } from "./use-conversation-image-asset";

const EMPTY_IMAGE_SRC = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
const MAX_IMAGE_REFETCHES = 2;

function GalleryControls({
  canGoNext,
  canGoPrevious,
  onNext,
  onPrevious,
  overflowCount,
  onOpenCanvas,
}: {
  canGoNext: boolean;
  canGoPrevious: boolean;
  onNext: () => void;
  onPrevious: () => void;
  overflowCount: number;
  onOpenCanvas?: () => void;
}) {
  return (
    <>
      <div className="pointer-events-none absolute right-2 bottom-2 inline-flex h-6 items-center gap-0.5 rounded-full bg-black/45 pr-2 pl-1.5 text-sm font-medium leading-none text-white shadow-sm backdrop-blur-[12px] group-focus-within/generated-image-gallery-controls:opacity-0 group-hover/generated-image-gallery-controls:opacity-0">
        <ImageMultiSelectIcon className="size-4 shrink-0" aria-hidden="true" />
        <span className="tabular-nums">{overflowCount}</span>
      </div>
      <div className="pointer-events-none absolute right-2 bottom-2 z-10 flex items-center gap-1 opacity-0 group-focus-within/generated-image-gallery-controls:pointer-events-auto group-focus-within/generated-image-gallery-controls:opacity-100 group-hover/generated-image-gallery-controls:pointer-events-auto group-hover/generated-image-gallery-controls:opacity-100">
        {onOpenCanvas ? (
          <button
            type="button"
            aria-label="Open Canvas view"
            className="flex h-6 cursor-interaction items-center gap-1 rounded-full bg-black/45 px-2 text-sm text-white shadow-sm backdrop-blur-[12px] hover:bg-black/60"
            onClick={onOpenCanvas}
          >
            <ImageCanvasViewIcon aria-hidden="true" className="size-3.5" />
            Canvas
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Previous images"
          disabled={!canGoPrevious}
          className="flex size-6 cursor-interaction items-center justify-center rounded-full bg-black/45 p-0 text-white shadow-sm backdrop-blur-[12px] enabled:hover:bg-black/60 disabled:bg-black/45 disabled:text-white/45 disabled:opacity-100"
          onClick={onPrevious}
          onPointerUp={(event) => event.currentTarget.blur()}
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Next images"
          disabled={!canGoNext}
          className="flex size-6 cursor-interaction items-center justify-center rounded-full bg-black/45 p-0 text-white shadow-sm backdrop-blur-[12px] enabled:hover:bg-black/60 disabled:bg-black/45 disabled:text-white/45 disabled:opacity-100"
          onClick={onNext}
          onPointerUp={(event) => event.currentTarget.blur()}
        >
          <ChevronRightIcon className="size-4" aria-hidden="true" />
        </button>
      </div>
    </>
  );
}

function GeneratedImageTile({
  heightPx,
  hidden,
  image,
  imageNumber,
  onAspectRatioChange,
  onOpen,
  onEdit,
  square,
  widthPx,
}: {
  heightPx: number;
  hidden: boolean;
  image: ThreadGeneratedImageGalleryItemModel;
  imageNumber: number;
  onAspectRatioChange: (ratio: number) => void;
  onOpen: () => void;
  onEdit?: () => void;
  square: boolean;
  widthPx: number;
}) {
  const previewAsset = useConversationImageAsset(image.previewSrc ?? image.src, {
    shouldLoadFileDataUrl: false,
  });
  const fullAsset = useConversationImageAsset(image.src ?? image.previewSrc ?? "", {
    shouldLoadFileDataUrl: false,
  });
  const [failure, setFailure] = useState<{ count: number; src: string } | null>(null);
  const previewSrc = previewAsset.previewSrc;
  const failureCount = failure?.src === previewSrc ? failure.count : 0;
  const alt = `Generated image ${imageNumber}`;

  if (!previewSrc) {
    return (
      <div
        className="generated-image-placeholder-pulse shrink-0 rounded-[16px]"
        style={{ height: heightPx, width: widthPx }}
      />
    );
  }

  return (
    <>
      <button
        type="button"
        aria-hidden={hidden || undefined}
        aria-label={alt}
        data-testid="generated-image-preview"
        tabIndex={hidden ? -1 : undefined}
        className="shrink-0 cursor-interaction overflow-hidden rounded-[16px] bg-token-main-surface-primary focus-visible:ring-1 focus-visible:ring-token-focus-border focus-visible:outline-none"
        style={{ height: heightPx, width: widthPx }}
        onClick={onOpen}
      >
        <img
          src={previewSrc}
          alt={alt}
          draggable
          className={cn("block h-full", square ? "w-full object-cover" : "w-auto object-contain")}
          referrerPolicy="no-referrer"
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = "copy";
            event.dataTransfer.setData(
              "application/x-codex-image",
              JSON.stringify({
                filename: `generated-image-${imageNumber}`,
                src:
                  fullAsset.dataUrl ?? fullAsset.downloadSrc ?? fullAsset.previewSrc ?? previewSrc,
              }),
            );
          }}
          onLoad={(event) => {
            setFailure(null);
            const { naturalHeight, naturalWidth } = event.currentTarget;
            if (naturalHeight <= 0 || naturalWidth <= 0) return;
            onAspectRatioChange(naturalWidth / naturalHeight);
          }}
          onError={() => {
            if (failureCount >= MAX_IMAGE_REFETCHES) return;
            setFailure({ count: failureCount + 1, src: previewSrc });
            void previewAsset.refetch();
          }}
        />
      </button>
      {onEdit ? (
        <button
          type="button"
          aria-label={`Edit generated image ${imageNumber}`}
          className="pointer-events-none absolute bottom-2 left-2 z-10 flex h-6 cursor-interaction items-center gap-1 rounded-full bg-black/45 px-2 text-sm text-white opacity-0 shadow-sm backdrop-blur-[12px] group-focus-within/generated-image-preview:pointer-events-auto group-focus-within/generated-image-preview:opacity-100 group-hover/generated-image-preview:pointer-events-auto group-hover/generated-image-preview:opacity-100 hover:bg-black/60"
          onClick={onEdit}
        >
          <EditIcon aria-hidden="true" className="size-3.5" />
          Edit
        </button>
      ) : null}
    </>
  );
}

function GeneratedImagePreview({
  availableImageCount,
  image,
  imageNumber,
  onNextImage,
  onOpenChange,
  finalFocus,
  onPreviousImage,
  onEditImage,
}: {
  availableImageCount: number;
  image: ThreadGeneratedImageGalleryItemModel;
  imageNumber: number;
  onNextImage?: () => void;
  onOpenChange: (open: boolean) => void;
  finalFocus?: ComponentProps<typeof ImagePreviewDialog>["finalFocus"];
  onPreviousImage?: () => void;
  onEditImage?: () => void;
}) {
  const fullAsset = useConversationImageAsset(image.src ?? image.previewSrc ?? "", {
    shouldLoadFileDataUrl: true,
  });
  const alt = `Generated image ${imageNumber}`;

  return (
    <ImagePreviewDialog
      open
      onOpenChange={onOpenChange}
      src={fullAsset.previewSrc ?? EMPTY_IMAGE_SRC}
      downloadSrc={fullAsset.downloadSrc ?? EMPTY_IMAGE_SRC}
      alt={alt}
      analytics={{
        availableImageCount,
        entrypoint: "image_click",
        imageSource: "generated",
      }}
      finalFocus={finalFocus}
      onPreviousImage={onPreviousImage}
      onNextImage={onNextImage}
      onEditImage={onEditImage}
    />
  );
}

export function GeneratedImageGallery({
  groupId = "generated-image-gallery",
  images,
  pendingImageCount,
  turnStartedAtMs = null,
}: {
  groupId?: string;
  images: readonly ThreadGeneratedImageGalleryItemModel[];
  pendingImageCount: number;
  turnStartedAtMs?: number | null;
}) {
  const { composerTarget, conversationId } = useConversationImageAssetContext();
  const canonicalGeneratedGroups = useCodexConversationValue(
    conversationId,
    projectGeneratedImageCanonicalGroups,
    areGeneratedImageLiveGroupsEqual,
  );
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidthPx, setContainerWidthPx] = useState<number | null>(null);
  const [aspectRatios, setAspectRatios] = useState<Readonly<Record<string, number>>>({});
  const [startIndex, setStartIndex] = useState(0);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const previewTriggerRef = useRef<HTMLButtonElement | null>(null);
  const localEditorImages = useMemo<GeneratedImageDescriptor[]>(() => {
    const canonicalImagesById = new Map(
      canonicalGeneratedGroups.flatMap((group) => group.images).map((image) => [image.id, image]),
    );
    return images.map((image, index) => {
      const canonical = canonicalImagesById.get(image.id);
      const alt = canonical?.alt ?? `Generated image ${index + 1}`;
      return {
        id: image.id,
        alt,
        attachmentId: image.id.startsWith("image-playground:")
          ? image.id
          : `image-playground:${image.id}`,
        attachmentSrc: image.src ?? image.previewSrc ?? "",
        downloadSrc: image.src ?? image.previewSrc ?? "",
        generatedOrdinal: canonical?.generatedOrdinal ?? index + 1,
        groupId,
        previewSrc: image.previewSrc ?? image.src,
        referrerPolicy: "no-referrer",
        source: "generated",
        src: image.src ?? image.previewSrc ?? "",
        status: "ready",
        tabTitle: canonical?.tabTitle ?? alt,
        turnStartedAtMs: turnStartedAtMs ?? undefined,
      };
    });
  }, [canonicalGeneratedGroups, groupId, images, turnStartedAtMs]);
  const getLiveCollectionSnapshot = useCallback(
    () => getGeneratedImageLiveCollectionSnapshot(conversationId ?? ""),
    [conversationId],
  );
  const liveCollection = useSyncExternalStore(
    subscribeGeneratedImageLiveCollections,
    getLiveCollectionSnapshot,
    getLiveCollectionSnapshot,
  );

  useEffect(() => {
    if (!conversationId) return undefined;
    return replaceGeneratedImageLiveGroup(conversationId, {
      id: groupId,
      images: localEditorImages,
      pendingImageCount,
      turnStartedAtMs,
    });
  }, [conversationId, groupId, localEditorImages, pendingImageCount, turnStartedAtMs]);

  useEffect(() => {
    if (!conversationId) return undefined;
    return replaceGeneratedImageCanonicalGroups(conversationId, canonicalGeneratedGroups);
  }, [canonicalGeneratedGroups, conversationId]);

  const resolveEditorImages = () => {
    if (!conversationId) return localEditorImages;
    const liveImages = liveCollection.images;
    return liveImages.length > 0 ? liveImages : localEditorImages;
  };

  const openEditor = (
    index: number,
    entrypoint: "gallery_edit_button" | "lightbox_edit_button",
  ) => {
    const clickedImage = localEditorImages[index];
    const editorImages = resolveEditorImages();
    const image = editorImages.find((candidate) => candidate.id === clickedImage?.id);
    if (!image) return;
    void openUserAttachmentImagePreview({
      alt: image.alt,
      attachmentId: image.attachmentId,
      attachmentSrc: image.attachmentSrc,
      availableImageCount: editorImages.length,
      composerTarget: composerTarget ?? undefined,
      downloadSrc: image.downloadSrc,
      entrypoint,
      generatedImages: editorImages,
      imageSource: "generated",
      initialImageId: image.id,
      initialView: "single",
      openInEditor: true,
      policy: "edit_button",
      previewSrc: image.previewSrc,
      referrerPolicy: "no-referrer",
      src: image.src,
      threadId: conversationId,
      title: image.tabTitle,
    });
  };

  const liveImageCount = conversationId
    ? liveCollection.images.filter((image) => image.status === "ready").length
    : localEditorImages.length;
  const openCanvas =
    Math.max(localEditorImages.length, liveImageCount) > 1
      ? () => {
          const editorImages = resolveEditorImages();
          const image = editorImages.at(-1);
          if (!image) return;
          void openUserAttachmentImagePreview({
            alt: image.alt,
            attachmentId: image.attachmentId,
            attachmentSrc: image.attachmentSrc,
            availableImageCount: editorImages.length,
            composerTarget: composerTarget ?? undefined,
            downloadSrc: image.downloadSrc,
            entrypoint: "canvas_button",
            generatedImages: editorImages,
            imageSource: "generated",
            initialImageId: image.id,
            initialView: "playground",
            openInEditor: true,
            policy: "edit_button",
            previewSrc: image.previewSrc,
            referrerPolicy: "no-referrer",
            src: image.src,
            threadId: conversationId,
            title: image.tabTitle,
          });
        }
      : undefined;

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const updateWidth = (width: number) => {
      const nextWidth = Math.floor(width);
      setContainerWidthPx((current) => (current === nextWidth ? current : nextWidth));
    };
    updateWidth(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) updateWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const ratios = [
    ...images.map((image) => aspectRatios[image.id] ?? 1),
    ...Array.from({ length: pendingImageCount }, () => 1),
  ];
  const layout = calculateGeneratedImageGalleryLayout({
    containerWidthPx,
    imageAspectRatios: ratios,
    minimumSlotCount: pendingImageCount > 0 ? 4 : 0,
  });
  const resolvedStartIndex = Math.min(startIndex, layout.maxStartIndex);
  const translateX =
    layout.aspectRatio === "square" ? resolvedStartIndex * (layout.heightPx + 8) : 0;
  const activePreviewImage = previewIndex === null ? null : (images[previewIndex] ?? null);
  const handlePreviewOpenChange = useCallback((open: boolean) => {
    if (!open) setPreviewIndex(null);
  }, []);

  return (
    <>
      <div
        ref={containerRef}
        data-testid="generated-image-gallery"
        className={cn(
          "group/generated-image-gallery-controls relative overflow-hidden",
          images.length === 1 && pendingImageCount === 0 && "w-full max-w-[400px]",
        )}
        style={{ height: layout.heightPx }}
      >
        <div
          className="flex gap-2 transition-transform duration-basic ease-out motion-reduce:transition-none"
          style={{
            height: layout.heightPx,
            transform: translateX === 0 ? undefined : `translateX(-${translateX}px)`,
          }}
        >
          {images.map((image, index) => {
            const hidden =
              layout.aspectRatio === "square" &&
              (index < resolvedStartIndex || index >= resolvedStartIndex + layout.visibleCount);
            const width =
              layout.aspectRatio === "square"
                ? layout.heightPx
                : (aspectRatios[image.id] ?? 1) * layout.heightPx;
            return (
              <div key={image.id} className="group/generated-image-preview relative shrink-0">
                <GeneratedImageTile
                  heightPx={layout.heightPx}
                  hidden={hidden}
                  image={image}
                  imageNumber={index + 1}
                  square={layout.aspectRatio === "square"}
                  widthPx={width}
                  onAspectRatioChange={(ratio) => {
                    setAspectRatios((current) =>
                      current[image.id] === ratio ? current : { ...current, [image.id]: ratio },
                    );
                  }}
                  onOpen={() => {
                    const trigger = document.activeElement;
                    previewTriggerRef.current =
                      trigger instanceof HTMLButtonElement ? trigger : null;
                    setPreviewIndex(index);
                  }}
                  onEdit={() => openEditor(index, "gallery_edit_button")}
                />
                {index === images.length - 1 && layout.overflowCount === 0 && openCanvas ? (
                  <div className="pointer-events-none absolute right-2 bottom-2 z-10 opacity-0 group-focus-within/generated-image-gallery-controls:pointer-events-auto group-focus-within/generated-image-gallery-controls:opacity-100 group-hover/generated-image-gallery-controls:pointer-events-auto group-hover/generated-image-gallery-controls:opacity-100">
                    <button
                      type="button"
                      aria-label="Open Canvas view"
                      className="flex h-6 cursor-interaction items-center gap-1 rounded-full bg-black/45 px-2 text-sm text-white shadow-sm backdrop-blur-[12px] hover:bg-black/60"
                      onClick={openCanvas}
                    >
                      <ImageCanvasViewIcon aria-hidden="true" className="size-3.5" />
                      Canvas
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
          {Array.from({ length: pendingImageCount }, (_, index) => {
            const absoluteIndex = images.length + index;
            const hidden =
              layout.aspectRatio === "square" &&
              (absoluteIndex < resolvedStartIndex ||
                absoluteIndex >= resolvedStartIndex + layout.visibleCount);
            return (
              <div
                key={`pending-image-${index}`}
                className="relative shrink-0"
                aria-hidden={hidden || undefined}
                style={{ height: layout.heightPx, width: layout.heightPx }}
              >
                <GeneratedImagePlaceholder hidden={hidden} seed={`${groupId}:pending:${index}`} />
              </div>
            );
          })}
        </div>
        {layout.aspectRatio === "square" && layout.overflowCount > 0 ? (
          <GalleryControls
            overflowCount={layout.overflowCount}
            canGoPrevious={resolvedStartIndex > 0}
            canGoNext={resolvedStartIndex < layout.maxStartIndex}
            onPrevious={() => setStartIndex(Math.max(resolvedStartIndex - 1, 0))}
            onNext={() => setStartIndex(Math.min(resolvedStartIndex + 1, layout.maxStartIndex))}
            onOpenCanvas={openCanvas}
          />
        ) : null}
      </div>
      {activePreviewImage ? (
        <GeneratedImagePreview
          availableImageCount={images.length}
          image={activePreviewImage}
          imageNumber={(previewIndex ?? 0) + 1}
          finalFocus={() => {
            previewTriggerRef.current?.focus();
            return false;
          }}
          onOpenChange={handlePreviewOpenChange}
          onPreviousImage={
            previewIndex !== null && previewIndex > 0
              ? () => setPreviewIndex(previewIndex - 1)
              : undefined
          }
          onNextImage={
            previewIndex !== null && previewIndex < images.length - 1
              ? () => setPreviewIndex(previewIndex + 1)
              : undefined
          }
          onEditImage={() => openEditor(previewIndex ?? 0, "lightbox_edit_button")}
        />
      ) : null}
    </>
  );
}
