import { useEffect, useState, type CSSProperties, type Ref } from "react";
import { motion } from "motion/react";
import {
  CheckmarkIcon,
  ImageCommentIcon,
  ImageMultiSelectIcon,
  RetryIcon,
} from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useResolvedImageAsset } from "../adapters/use-resolved-image-asset";
import {
  formatGeneratedImageGroupTime,
  isGeneratedImageTileEmphasized,
} from "../model/generated-image-canvas-presentation";
import type { GeneratedImageDescriptor, ImageComment, PlaygroundTool } from "../model/types";
import { ImageCommentSurface } from "./image-comment-surface";
import { ImageCommentModeToolbar, ImageEditorToolbarPill } from "./image-editor-toolbar";
import { ImageZoomControl } from "./image-zoom-control";
import { useImageZoomGestures } from "./use-image-zoom-gestures";
import { GeneratedImageDotField } from "./generated-image-dot-field";

export interface GeneratedImagePlaygroundGroup {
  id: string;
  images: readonly GeneratedImageDescriptor[];
  turnStartedAtMs: number | null;
}

export interface GeneratedImagePlaygroundProps {
  activeDraftImageId: string | null;
  activeImageId: string;
  commentsByImageId: Readonly<Record<string, readonly ImageComment[]>>;
  focusedImageRef?: Ref<HTMLButtonElement>;
  groups: readonly GeneratedImagePlaygroundGroup[];
  isSubmitting?: boolean;
  isViewTransitioning?: boolean;
  selectedImageIds: ReadonlySet<string>;
  tool: PlaygroundTool;
  zoomPercent: number;
  onActiveDraftImageIdChange: (imageId: string | null) => void;
  onCommentsChange: (imageId: string, comments: readonly ImageComment[]) => void;
  onImageActivate: (image: GeneratedImageDescriptor, displaySrc: string) => void;
  onResolvedSource: (imageId: string, displaySrc: string) => void;
  onSendComments: () => void;
  onToolChange: (tool: PlaygroundTool) => void;
  onZoomPercentChange: (zoomPercent: number) => void;
}

function GeneratedImageLoadingCard({ active, imageId }: { active: boolean; imageId: string }) {
  return (
    <div
      aria-busy="true"
      aria-label="Generating image…"
      className={cn(
        "relative aspect-square w-72 max-w-full shrink-0 overflow-hidden rounded-2xl bg-token-list-active-selection-background text-token-text-secondary",
        active && "ring-2 ring-token-charts-blue",
      )}
    >
      <GeneratedImageDotField presentation="playground" seed={imageId} />
    </div>
  );
}

function GeneratedImagePlaygroundCard({
  active,
  comments,
  focusedImageRef,
  image,
  isDraftActive,
  isViewTransitioning,
  selected,
  tool,
  onActivate,
  onDeleteComment,
  onDraftActiveChange,
  onResolvedSource,
  onSubmitComment,
}: {
  active: boolean;
  comments: readonly ImageComment[];
  focusedImageRef?: Ref<HTMLButtonElement>;
  image: GeneratedImageDescriptor;
  isDraftActive: boolean;
  isViewTransitioning: boolean;
  selected: boolean;
  tool: PlaygroundTool;
  onActivate: (displaySrc: string) => void;
  onDeleteComment: (commentId: string) => void;
  onDraftActiveChange: (active: boolean) => void;
  onResolvedSource: (displaySrc: string) => void;
  onSubmitComment: (comment: ImageComment) => void;
}) {
  const asset = useResolvedImageAsset(image.previewSrc ?? image.src, {
    allowLocalPath: true,
  });
  const displaySrc = asset.previewSrc ?? image.previewSrc ?? image.src;
  const [renderFailed, setRenderFailed] = useState(false);
  const [statusRetryRequested, setStatusRetryRequested] = useState(false);

  useEffect(() => {
    setStatusRetryRequested(false);
  }, [image.id, image.status]);

  useEffect(() => {
    if (!displaySrc) return;
    setRenderFailed(false);
    onResolvedSource(
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
    image.attachmentSrc,
    image.dataUrl,
    image.downloadSrc,
    image.localPath,
    image.src,
    onResolvedSource,
  ]);

  if (asset.isLoading) {
    return <GeneratedImageLoadingCard active={active} imageId={image.id} />;
  }
  if (
    asset.isError ||
    renderFailed ||
    !displaySrc ||
    (image.status === "failed" && !statusRetryRequested)
  ) {
    return (
      <div
        role="alert"
        className="flex aspect-square w-72 max-w-full shrink-0 flex-col items-center justify-center gap-2 rounded-xl bg-token-error-background p-4 text-center text-sm text-token-text-secondary ring-1 ring-token-border"
      >
        <span>Image could not be loaded</span>
        <NodexButton
          variant="outline"
          size="sm"
          onClick={() => {
            setRenderFailed(false);
            setStatusRetryRequested(true);
            void asset.refetch();
          }}
        >
          <RetryIcon aria-hidden="true" className="icon-xs" />
          Retry
        </NodexButton>
      </div>
    );
  }

  if (tool === "comment") {
    const emphasized = isGeneratedImageTileEmphasized({
      active,
      commentCount: comments.length,
      draftActive: isDraftActive,
      selected,
      tool,
    });
    return (
      <div className={cn("relative max-w-full shrink-0", active && isViewTransitioning && "z-10")}>
        <div
          className={cn(
            "relative flex max-w-full shrink-0 items-center rounded-xl bg-token-bg-tertiary outline-none",
            emphasized && "ring-2 ring-token-charts-blue",
          )}
        >
          <ImageCommentSurface
            alt={image.alt}
            comments={comments}
            imageRef={active ? focusedImageRef : undefined}
            isDraftActive={isDraftActive}
            layout="playground"
            referrerPolicy={image.referrerPolicy ?? "no-referrer"}
            src={displaySrc}
            onDeleteComment={onDeleteComment}
            onDraftActiveChange={onDraftActiveChange}
            onSubmitComment={onSubmitComment}
          />
        </div>
      </div>
    );
  }

  const pressed = isGeneratedImageTileEmphasized({
    active,
    commentCount: comments.length,
    draftActive: isDraftActive,
    selected,
    tool,
  });
  return (
    <div className={cn("relative max-w-full shrink-0", active && isViewTransitioning && "z-10")}>
      <button
        ref={active ? focusedImageRef : undefined}
        type="button"
        aria-label={image.alt}
        aria-pressed={pressed}
        className={cn(
          "relative block max-w-full shrink-0 cursor-interaction overflow-hidden rounded-xl bg-token-bg-tertiary outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border active:scale-[0.995]",
          pressed && "ring-2 ring-token-charts-blue",
        )}
        onClick={() => onActivate(displaySrc)}
      >
        <img
          alt=""
          className="block h-auto !max-h-[292px] w-auto max-w-full object-contain"
          decoding="async"
          draggable={false}
          referrerPolicy={image.referrerPolicy ?? "no-referrer"}
          src={displaySrc}
          onError={() => setRenderFailed(true)}
        />
        {tool === "select" && selected ? (
          <span className="absolute top-2 right-2 rounded-full bg-token-main-surface-primary text-token-charts-blue shadow-sm">
            <CheckmarkIcon aria-hidden="true" className="size-5" />
          </span>
        ) : null}
      </button>
    </div>
  );
}

function PlaygroundToolbar({
  commentCount,
  isSubmitting,
  tool,
  onSendComments,
  onToolChange,
}: {
  commentCount: number;
  isSubmitting: boolean;
  tool: PlaygroundTool;
  onSendComments: () => void;
  onToolChange: (tool: PlaygroundTool) => void;
}) {
  if (tool === "comment") {
    return (
      <ImageCommentModeToolbar
        ariaLabel="Image playground tools"
        commentCount={commentCount}
        emptyMessage="Add comments on multiple images to batch edit them"
        isSubmitting={isSubmitting}
        onCancel={() => onToolChange("navigate")}
        onSend={onSendComments}
      />
    );
  }

  const selecting = tool === "select";
  return (
    <ImageEditorToolbarPill ariaLabel="Image playground tools">
      <NodexButton
        variant="ghost"
        size="composer"
        className="!h-token-button-composer-sm !gap-1 !rounded-full !px-2 !text-base"
        onClick={() => onToolChange("comment")}
      >
        <ImageCommentIcon aria-hidden="true" className="icon-xs" />
        Comment
      </NodexButton>
      <NodexButton
        variant={selecting ? "secondary" : "ghost"}
        size="composer"
        aria-pressed={selecting}
        className="!h-token-button-composer-sm !gap-1 !rounded-full !px-2 !text-base"
        onClick={() => onToolChange(selecting ? "navigate" : "select")}
      >
        <ImageMultiSelectIcon aria-hidden="true" className="icon-xs" />
        Multi-select
      </NodexButton>
    </ImageEditorToolbarPill>
  );
}

export function GeneratedImagePlayground({
  activeDraftImageId,
  activeImageId,
  commentsByImageId,
  focusedImageRef,
  groups,
  isSubmitting = false,
  isViewTransitioning = false,
  selectedImageIds,
  tool,
  zoomPercent,
  onActiveDraftImageIdChange,
  onCommentsChange,
  onImageActivate,
  onResolvedSource,
  onSendComments,
  onToolChange,
  onZoomPercentChange,
}: GeneratedImagePlaygroundProps) {
  const commentCount = groups.reduce(
    (total, group) =>
      total +
      group.images.reduce(
        (groupTotal, image) => groupTotal + (commentsByImageId[image.id]?.length ?? 0),
        0,
      ),
    0,
  );
  const zoomStyle = { zoom: zoomPercent / 100 } as CSSProperties;
  const zoomGestures = useImageZoomGestures({
    onZoomPercentChange,
    zoomPercent,
  });

  return (
    <div
      className="relative h-full min-h-0 bg-token-bg-primary"
      data-testid="generated-image-playground"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented || tool === "navigate") return;
        event.preventDefault();
        event.stopPropagation();
        onToolChange("navigate");
      }}
    >
      <div className="pointer-events-none absolute top-2 right-0 left-0 z-40 flex justify-center px-4">
        <div className={isViewTransitioning ? undefined : "pointer-events-auto"}>
          <PlaygroundToolbar
            commentCount={commentCount}
            isSubmitting={isSubmitting}
            tool={tool}
            onSendComments={onSendComments}
            onToolChange={onToolChange}
          />
        </div>
      </div>
      <div className="absolute top-2 right-2 z-40 flex h-8 items-center">
        <ImageZoomControl
          fitSelected={false}
          showFitOption={false}
          zoomPercent={zoomPercent}
          onZoomPercentChange={zoomGestures.setZoomAtViewportCenter}
          onZoomToFit={() => zoomGestures.setZoomAtViewportCenter(100)}
        />
      </div>
      <div
        ref={zoomGestures.setScrollContainerRef}
        data-generated-image-playground-scroll
        className="h-full min-h-0 scroll-pt-14 overflow-auto ps-3 pe-16 pt-14 pb-[calc(var(--right-panel-composer-overlay-reserve,0px)+var(--spacing)*6)]"
        onClickCapture={zoomGestures.handleClickCapture}
        onPointerMoveCapture={zoomGestures.handlePointerMoveCapture}
      >
        <div
          ref={zoomGestures.zoomTargetRef}
          className="flex min-w-max flex-col items-start gap-6"
          style={zoomStyle}
        >
          {groups.map((group) => (
            <motion.div
              key={group.id}
              initial={{
                opacity:
                  !isViewTransitioning || group.images.some((image) => image.id === activeImageId)
                    ? 1
                    : 0,
              }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.14, delay: isViewTransitioning ? 0.24 : 0 }}
              className={cn(
                "relative flex max-w-full gap-2",
                (group.turnStartedAtMs !== null || group.images.some((image) => image.loading)) &&
                  "pt-6",
              )}
            >
              {group.turnStartedAtMs !== null ? (
                <time
                  className="absolute top-0 text-xs text-token-text-tertiary select-none"
                  dateTime={new Date(group.turnStartedAtMs).toISOString()}
                >
                  {formatGeneratedImageGroupTime(group.turnStartedAtMs)}
                </time>
              ) : null}
              {group.images.map((image) => {
                const active = image.id === activeImageId;
                if (image.loading || image.status === "loading") {
                  return (
                    <div key={image.id} className="w-72 max-w-full shrink-0">
                      <GeneratedImageLoadingCard active={active} imageId={image.id} />
                    </div>
                  );
                }
                const comments = commentsByImageId[image.id] ?? [];
                return (
                  <GeneratedImagePlaygroundCard
                    key={image.id}
                    active={active}
                    comments={comments}
                    focusedImageRef={focusedImageRef}
                    image={image}
                    isDraftActive={activeDraftImageId === image.id}
                    isViewTransitioning={active && isViewTransitioning}
                    selected={selectedImageIds.has(image.id)}
                    tool={tool}
                    onActivate={(displaySrc) => onImageActivate(image, displaySrc)}
                    onDeleteComment={(commentId) => {
                      onCommentsChange(
                        image.id,
                        comments.filter((comment) => comment.id !== commentId),
                      );
                    }}
                    onDraftActiveChange={(activeDraft) => {
                      onActiveDraftImageIdChange(activeDraft ? image.id : null);
                    }}
                    onResolvedSource={(displaySrc) => {
                      onResolvedSource(image.id, displaySrc);
                    }}
                    onSubmitComment={(comment) => {
                      const existing = comments.some((candidate) => candidate.id === comment.id);
                      onCommentsChange(
                        image.id,
                        existing
                          ? comments.map((candidate) =>
                              candidate.id === comment.id ? comment : candidate,
                            )
                          : [...comments, comment],
                      );
                    }}
                  />
                );
              })}
            </motion.div>
          ))}
          <div className="h-1/2" />
        </div>
      </div>
    </div>
  );
}
