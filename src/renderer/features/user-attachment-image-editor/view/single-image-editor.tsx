import { useEffect, useState, type ReactNode, type Ref } from "react";
import {
  ChevronDownIcon,
  DownloadIcon,
  FolderOpenIcon,
  ImageEditorTabIcon,
  ImageCommentIcon,
  ImageRemoveIcon,
  ImageResizeIcon,
  LandscapeAspectRatioIcon,
  LoadingIcon,
  PortraitAspectRatioIcon,
  RetryIcon,
  SquareAspectRatioIcon,
  StoryAspectRatioIcon,
  WidescreenAspectRatioIcon,
} from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import { NodexDropdownItem, NodexDropdownMenu } from "@/components/ui/dropdown";
import { toast } from "@/components/ui/toast";
import { invoke } from "@/lib/api";
import { cn } from "@/lib/utils";
import { trackImageToolOpen } from "../analytics/image-editor-analytics";
import {
  createImageDownloadFilename,
  downloadImageDataUrl,
} from "../adapters/resolved-image-asset";
import { useResolvedImageAsset } from "../adapters/use-resolved-image-asset";
import {
  buildCommentSubmissionIntent,
  buildRemoveSubmissionIntent,
  buildResizeSubmissionIntent,
  IMAGE_ASPECT_RATIO_OPTIONS,
} from "../model/image-edit-submission";
import type {
  EditableImageDescriptor,
  ImageAspectRatio,
  ImageComment,
  ImageEditSubmissionIntent,
  ImagePreviewEntrypoint,
  SingleImageTool,
} from "../model/types";
import type { ImageEditComposerSubmitResult } from "@/lib/image-edit-composer-channel";
import { ImageCommentSurface } from "./image-comment-surface";
import { ImageCommentModeToolbar, ImageEditorToolbarPill } from "./image-editor-toolbar";
import { ImageRemoveEditor } from "./image-remove-editor";
import { GeneratedImageDotField } from "./generated-image-dot-field";
import { ImageZoomViewer } from "./image-zoom-viewer";

const ASPECT_RATIO_ICONS = {
  "1:1": SquareAspectRatioIcon,
  "3:4": PortraitAspectRatioIcon,
  "9:16": StoryAspectRatioIcon,
  "4:3": LandscapeAspectRatioIcon,
  "16:9": WidescreenAspectRatioIcon,
} satisfies Record<ImageAspectRatio, typeof SquareAspectRatioIcon>;

export interface SingleImageEditorProps {
  comments: readonly ImageComment[];
  entrypoint: ImagePreviewEntrypoint;
  hasImageRail?: boolean;
  image: EditableImageDescriptor;
  imageRef?: Ref<HTMLImageElement>;
  isSubmitting?: boolean;
  onCommentsChange: (comments: readonly ImageComment[]) => void;
  onResolvedSource?: (displaySrc: string) => void;
  onRequestCommentSubmit?: () => Promise<ImageEditComposerSubmitResult>;
  onSubmitIntent: (intent: ImageEditSubmissionIntent) => Promise<boolean>;
  onToolChange?: (tool: SingleImageTool) => void;
  tool?: SingleImageTool;
}

function EditorLoadingState({ children }: { children?: ReactNode }) {
  return (
    <div
      role="status"
      className="[container-type:size] flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4 text-token-text-tertiary"
    >
      {children ?? <LoadingIcon aria-hidden="true" className="icon-sm animate-spin" />}
    </div>
  );
}

function GeneratedImageLoadingState({ imageId }: { imageId: string }) {
  return (
    <EditorLoadingState>
      <div
        aria-busy="true"
        aria-label="Generating image..."
        className="electron-dark:bg-token-list-hover-background electron-dark:text-white/70 relative aspect-square size-[min(100cqw,100cqh)] overflow-clip rounded-2xl bg-token-list-active-selection-background text-token-text-secondary dark:bg-token-list-hover-background dark:text-white/70"
      >
        <GeneratedImageDotField presentation="single" seed={imageId} />
      </div>
    </EditorLoadingState>
  );
}

function LocalImageOpenControl({
  disabled,
  isDownloading,
  path,
  onDownload,
}: {
  disabled: boolean;
  isDownloading: boolean;
  path: string;
  onDownload: () => Promise<void>;
}) {
  const openPath = async (target: "default" | "fileManager") => {
    try {
      const opened =
        target === "default"
          ? await invoke("shell:open-path-default", path)
          : await invoke("shell:open-file-link", { path }, "fileManager");
      if (!opened) toast.danger("Could not open image");
    } catch {
      toast.danger("Could not open image");
    }
  };

  return (
    <div
      data-tab-preview-pin-exempt="true"
      className="flex h-token-button-composer-sm overflow-hidden rounded-lg border border-token-border bg-token-main-surface-primary text-token-foreground shadow-sm"
    >
      <button
        type="button"
        aria-label="Open image"
        disabled={disabled}
        className="flex min-w-0 cursor-interaction items-center gap-1.5 px-2 text-base hover:bg-token-list-hover-background focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-token-focus-border focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        onClick={() => void openPath("default")}
      >
        <span className="flex size-4 items-center justify-center rounded-sm bg-token-charts-blue text-white">
          <ImageEditorTabIcon aria-hidden="true" className="size-3" />
        </span>
        <span className="whitespace-nowrap">Open</span>
      </button>
      <NodexDropdownMenu
        align="end"
        contentWidth="xs"
        disabled={disabled}
        triggerButton={
          <button
            type="button"
            aria-label="Open options"
            disabled={disabled}
            className="flex w-6 cursor-interaction items-center justify-center border-s border-token-border hover:bg-token-list-hover-background focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-token-focus-border focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ChevronDownIcon aria-hidden="true" className="icon-2xs" />
          </button>
        }
      >
        <NodexDropdownItem
          leftSlot={<FolderOpenIcon aria-hidden="true" className="icon-sm" />}
          onSelect={() => void openPath("fileManager")}
        >
          Open in folder
        </NodexDropdownItem>
        <NodexDropdownItem
          disabled={isDownloading}
          leftSlot={
            isDownloading ? (
              <LoadingIcon aria-hidden="true" className="icon-sm animate-spin" />
            ) : (
              <DownloadIcon aria-hidden="true" className="icon-sm" />
            )
          }
          onSelect={() => void onDownload()}
        >
          {isDownloading ? "Saving…" : "Save as…"}
        </NodexDropdownItem>
      </NodexDropdownMenu>
    </div>
  );
}

export function SingleImageEditor({
  comments,
  entrypoint,
  hasImageRail = false,
  image,
  imageRef,
  isSubmitting = false,
  onCommentsChange,
  onResolvedSource,
  onRequestCommentSubmit,
  onSubmitIntent,
  onToolChange,
  tool,
}: SingleImageEditorProps) {
  const previewSource = image.previewSrc ?? image.src;
  const asset = useResolvedImageAsset(previewSource, { allowLocalPath: true });
  const downloadAsset = useResolvedImageAsset(
    image.downloadSrc ?? image.attachmentSrc ?? image.src,
    { allowLocalPath: true },
  );
  const [uncontrolledTool, setUncontrolledTool] = useState<SingleImageTool>("navigate");
  const activeTool = tool ?? uncontrolledTool;
  const [manualZoomPercent, setManualZoomPercent] = useState<number | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [descriptorRetryRequested, setDescriptorRetryRequested] = useState(false);
  const displaySrc = asset.previewSrc;
  const isLoading = image.loading === true || asset.isLoading;
  const hasError =
    (image.error != null && !descriptorRetryRequested) ||
    asset.isError ||
    (!isLoading && !displaySrc);
  const canEdit = !isLoading && !hasError && displaySrc !== null && !isSubmitting;

  const selectTool = (tool: SingleImageTool) => {
    setUncontrolledTool(tool);
    onToolChange?.(tool);
  };

  useEffect(() => {
    setDescriptorRetryRequested(false);
  }, [image.error, image.id]);

  useEffect(() => {
    if (!displaySrc) return;
    onResolvedSource?.(
      downloadAsset.dataUrl ??
        asset.dataUrl ??
        image.dataUrl ??
        image.localPath ??
        image.downloadSrc ??
        image.attachmentSrc ??
        image.src,
    );
  }, [
    asset.dataUrl,
    displaySrc,
    downloadAsset.dataUrl,
    image.attachmentSrc,
    image.dataUrl,
    image.downloadSrc,
    image.localPath,
    image.src,
    onResolvedSource,
  ]);

  const submitAndExit = async (
    intent: ImageEditSubmissionIntent,
    nextTool: SingleImageTool = "navigate",
  ): Promise<boolean> => {
    const submitted = await onSubmitIntent(intent);
    if (submitted) selectTool(nextTool);
    return submitted;
  };

  const handleDownload = async () => {
    if (isDownloading) return;
    setIsDownloading(true);
    try {
      const dataUrl = await downloadAsset.materialize();
      downloadImageDataUrl(
        dataUrl,
        createImageDownloadFilename(image.downloadSrc ?? image.src, image.alt),
      );
    } catch {
      toast.danger("Could not download image");
    } finally {
      setIsDownloading(false);
    }
  };

  const downloadControl = (
    <div data-tab-preview-pin-exempt="true" className="flex items-center">
      {downloadAsset.localPath ? (
        <LocalImageOpenControl
          disabled={isLoading}
          isDownloading={isDownloading}
          path={downloadAsset.localPath}
          onDownload={handleDownload}
        />
      ) : null}
      {downloadAsset.localPath ? null : (
        <NodexButton
          variant="ghost"
          size="icon-xs"
          aria-label="Download"
          aria-busy={isDownloading || undefined}
          disabled={isLoading || isDownloading}
          className="!size-7 rounded-full"
          onClick={() => void handleDownload()}
        >
          {isDownloading ? (
            <LoadingIcon aria-hidden="true" className="icon-xs animate-spin" />
          ) : (
            <DownloadIcon aria-hidden="true" className="icon-xs" />
          )}
        </NodexButton>
      )}
    </div>
  );

  return (
    <div
      className={cn(
        "@container relative flex h-full min-h-0 w-full min-w-0 flex-col bg-token-bg-primary pb-[var(--right-panel-composer-overlay-reserve,0px)]",
        hasImageRail && "pe-18",
      )}
      data-testid="user-attachment-image-editor-single"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented || activeTool === "navigate") return;
        event.preventDefault();
        event.stopPropagation();
        if (activeTool === "comment") onCommentsChange([]);
        selectTool("navigate");
      }}
    >
      {activeTool !== "remove" && activeTool !== "comment" ? (
        <div className="relative flex shrink-0 justify-center gap-2 px-4 pt-2">
          <ImageEditorToolbarPill className="[@container_(max-width:450px)]:hidden">
            <NodexButton
              variant="ghost"
              size="composer"
              disabled={!canEdit}
              className="!h-token-button-composer-sm !gap-1 !rounded-full !px-2 !text-base"
              onClick={() => selectTool("comment")}
            >
              <ImageCommentIcon aria-hidden="true" className="icon-xs" />
              <span className="[@container_(max-width:630px)]:sr-only">Comment</span>
            </NodexButton>
            <NodexButton
              variant="ghost"
              size="composer"
              disabled={!canEdit}
              className="!h-token-button-composer-sm !gap-1 !rounded-full !px-2 !text-base"
              onClick={() => selectTool("remove")}
            >
              <ImageRemoveIcon aria-hidden="true" className="icon-xs" />
              <span className="[@container_(max-width:630px)]:sr-only">Remove</span>
            </NodexButton>
            <NodexDropdownMenu
              align="center"
              side="bottom"
              contentWidth="xs"
              disabled={!canEdit}
              triggerButton={
                <NodexButton
                  variant="ghost"
                  size="composer"
                  disabled={!canEdit}
                  aria-label="Resize"
                  aria-busy={isSubmitting || undefined}
                  className="!h-token-button-composer-sm !gap-1 !rounded-full !px-2 !text-base"
                  onClick={() =>
                    trackImageToolOpen({
                      imageSource: image.source,
                      mode: "resize",
                      view: "single",
                    })
                  }
                >
                  {isSubmitting ? (
                    <LoadingIcon aria-hidden="true" className="icon-sm animate-spin" />
                  ) : (
                    <ImageResizeIcon aria-hidden="true" className="icon-sm" />
                  )}
                  <span className="[@container_(max-width:630px)]:sr-only">Resize</span>
                </NodexButton>
              }
            >
              {IMAGE_ASPECT_RATIO_OPTIONS.map(({ label, ratio }) => {
                const Icon = ASPECT_RATIO_ICONS[ratio];
                return (
                  <NodexDropdownItem
                    key={ratio}
                    leftSlot={<Icon aria-hidden="true" className="icon-sm" />}
                    onSelect={() =>
                      void submitAndExit(
                        buildResizeSubmissionIntent({
                          aspectRatio: ratio,
                          entrypoint,
                          image,
                        }),
                      )
                    }
                  >
                    <span className="flex w-full items-center justify-between gap-4">
                      <span>{label}</span>
                      <span className="text-token-text-tertiary">{ratio}</span>
                    </span>
                  </NodexDropdownItem>
                );
              })}
            </NodexDropdownMenu>
          </ImageEditorToolbarPill>
          {isLoading || hasError || !displaySrc ? (
            <div className="absolute top-2 right-2 flex h-8 items-center">{downloadControl}</div>
          ) : null}
        </div>
      ) : null}

      {activeTool === "comment" && displaySrc ? (
        <>
          <div className="flex shrink-0 justify-center px-4 pt-2">
            <ImageCommentModeToolbar
              ariaLabel="Image comment controls"
              commentCount={comments.length}
              emptyMessage="Click on the image to add comments"
              isSubmitting={isSubmitting}
              onCancel={() => {
                onCommentsChange([]);
                selectTool("navigate");
              }}
              onSend={() => {
                void (async () => {
                  const composerResult = (await onRequestCommentSubmit?.()) ?? {
                    status: "unavailable" as const,
                    reason: "composer-unmounted" as const,
                  };
                  const submitted =
                    composerResult.status === "submitted" ||
                    composerResult.status === "queued" ||
                    (composerResult.status === "unavailable" &&
                      (await submitAndExit(
                        buildCommentSubmissionIntent({
                          commentedImages: [{ comments, image }],
                          entrypoint,
                        }),
                      )));
                  if (!submitted) return;
                  onCommentsChange([]);
                  selectTool("navigate");
                })();
              }}
            />
          </div>
          <ImageCommentSurface
            alt={image.alt}
            comments={comments}
            referrerPolicy={image.referrerPolicy}
            src={displaySrc}
            onDeleteComment={(commentId) => {
              onCommentsChange(comments.filter((comment) => comment.id !== commentId));
            }}
            onSubmitComment={(comment) => {
              const existing = comments.some((candidate) => candidate.id === comment.id);
              onCommentsChange(
                existing
                  ? comments.map((candidate) => (candidate.id === comment.id ? comment : candidate))
                  : [...comments, comment],
              );
            }}
          />
        </>
      ) : activeTool === "remove" && displaySrc ? (
        <ImageRemoveEditor
          alt={image.alt}
          isSubmitting={isSubmitting}
          referrerPolicy={image.referrerPolicy}
          src={displaySrc}
          onCancel={() => selectTool("navigate")}
          onSubmit={async (maskDataUrl) => {
            const mask: EditableImageDescriptor = {
              id: `image-mask:${crypto.randomUUID()}`,
              alt: "Image removal mask",
              attachmentSrc: maskDataUrl,
              dataUrl: maskDataUrl,
              downloadSrc: maskDataUrl,
              previewSrc: maskDataUrl,
              source: image.source,
              src: maskDataUrl,
            };
            await submitAndExit(
              buildRemoveSubmissionIntent({
                entrypoint,
                image,
                mask,
              }),
            );
          }}
        />
      ) : isLoading ? (
        image.source === "generated" && image.loading ? (
          <GeneratedImageLoadingState imageId={image.id} />
        ) : (
          <EditorLoadingState />
        )
      ) : hasError || !displaySrc ? (
        <EditorLoadingState>
          <div className="flex flex-col items-center gap-2 text-center">
            <span>Image could not be loaded</span>
            <NodexButton
              variant="outline"
              size="sm"
              onClick={() => {
                setDescriptorRetryRequested(true);
                void asset.refetch();
              }}
            >
              <RetryIcon aria-hidden="true" className="icon-xs" />
              Retry
            </NodexButton>
          </div>
        </EditorLoadingState>
      ) : (
        <ImageZoomViewer
          alt={image.alt}
          hasImageRail={hasImageRail}
          imageRef={imageRef}
          manualZoomPercent={manualZoomPercent}
          referrerPolicy={image.referrerPolicy}
          src={displaySrc}
          trailingControls={downloadControl}
          onManualZoomPercentChange={setManualZoomPercent}
        />
      )}
    </div>
  );
}
