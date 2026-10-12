import { useState, type CSSProperties, type MouseEvent, type PointerEvent, type Ref } from "react";
import { DeleteIcon, ImageCommentMarkerShape, UpArrowIcon } from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  clampImagePoint,
  computeCommentEditorLayoutMetrics,
  computeCommentEditorPlacement,
  IMAGE_COMMENT_MARKER_DIAMETER_PX,
} from "../model/image-geometry";
import type {
  CommentEditorLayoutMetrics,
  ImageComment,
  ImagePoint,
  ImageReferrerPolicy,
} from "../model/types";

type ActiveCommentDraft = ImagePoint &
  CommentEditorLayoutMetrics & {
    id?: string;
  };

export interface ImageCommentSurfaceProps {
  alt: string;
  comments: readonly ImageComment[];
  imageRef?: Ref<HTMLButtonElement>;
  isDraftActive?: boolean;
  layout?: "panel" | "playground";
  referrerPolicy?: ImageReferrerPolicy;
  src: string;
  onDeleteComment: (commentId: string) => void;
  onDraftActiveChange?: (active: boolean) => void;
  onSubmitComment: (comment: ImageComment) => void;
}

function measureEditorMetrics(surface: HTMLElement): CommentEditorLayoutMetrics | null {
  const parent = surface.parentElement;
  return computeCommentEditorLayoutMetrics({
    imageOffsetLeft: surface.offsetLeft,
    imageOffsetTop: surface.offsetTop,
    imageSize: {
      height: surface.clientHeight,
      width: surface.clientWidth,
    },
    parentSize: parent ? { height: parent.clientHeight, width: parent.clientWidth } : null,
    point: { x: 0, y: 0 },
  });
}

function pointFromPointer(
  event: MouseEvent<HTMLButtonElement> | PointerEvent<HTMLButtonElement>,
): ActiveCommentDraft | null {
  const rect = event.currentTarget.getBoundingClientRect();
  const surface = event.currentTarget.parentElement;
  if (!surface || rect.width <= 0 || rect.height <= 0) return null;
  const metrics = measureEditorMetrics(surface);
  if (!metrics) return null;
  return {
    ...metrics,
    ...clampImagePoint({
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    }),
  };
}

function resolveEditorPlacement(draft: ActiveCommentDraft, isEditing: boolean): CSSProperties {
  const placement = computeCommentEditorPlacement({
    metrics: draft,
    isEditingExistingComment: isEditing,
  });
  return {
    height: placement.height,
    left: placement.left,
    top: placement.top,
    width: placement.width,
  };
}

function ImageCommentMarker({
  ariaLabel,
  draft = false,
  draftTestId,
  label,
  point,
  onClick,
}: {
  ariaLabel?: string;
  draft?: boolean;
  draftTestId?: string;
  label: number | "";
  point: ImagePoint;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const markerStyle: CSSProperties = {
    color: "var(--image-comment-marker-color)",
    height: IMAGE_COMMENT_MARKER_DIAMETER_PX,
    left: `${point.x * 100}%`,
    top: `${point.y * 100}%`,
    width: IMAGE_COMMENT_MARKER_DIAMETER_PX,
  };
  const content = (
    <>
      <ImageCommentMarkerShape className="absolute inset-0 size-full" />
      <span className="pointer-events-none relative z-10 -translate-x-px -translate-y-px font-sans text-[10px] leading-none font-bold text-white">
        {label}
      </span>
    </>
  );

  if (draft || !onClick) {
    return (
      <div
        className="pointer-events-none absolute flex -translate-x-1/2 -translate-y-1/2 items-center justify-center border-0 bg-transparent p-0 font-sans"
        data-testid={draftTestId}
        style={markerStyle}
      >
        {content}
      </div>
    );
  }

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      className="pointer-events-auto absolute flex -translate-x-1/2 -translate-y-1/2 cursor-interaction items-center justify-center border-0 bg-transparent p-0 font-sans focus-visible:ring-2 focus-visible:ring-token-focus-border focus-visible:outline-none"
      data-testid="image-comment-marker"
      style={markerStyle}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick(event);
      }}
    >
      {content}
    </button>
  );
}

export function ImageCommentSurface({
  alt,
  comments,
  imageRef,
  isDraftActive = true,
  layout = "panel",
  referrerPolicy,
  src,
  onDeleteComment,
  onDraftActiveChange,
  onSubmitComment,
}: ImageCommentSurfaceProps) {
  const [storedDraft, setStoredDraft] = useState<ActiveCommentDraft | null>(null);
  const [hoverPoint, setHoverPoint] = useState<ImagePoint | null>(null);
  const [draftText, setDraftText] = useState("");
  const activeDraft = isDraftActive ? storedDraft : null;
  const existingIndex =
    activeDraft?.id === undefined
      ? -1
      : comments.findIndex((comment) => comment.id === activeDraft.id);
  const editingComment = existingIndex === -1 ? null : (comments[existingIndex] ?? null);

  const cancelDraft = () => {
    setStoredDraft(null);
    setDraftText("");
    onDraftActiveChange?.(false);
  };

  const saveDraft = () => {
    const text = draftText.trim();
    if (!activeDraft || text.length === 0) return;
    onSubmitComment({
      id: activeDraft.id ?? crypto.randomUUID(),
      text,
      ...clampImagePoint(activeDraft),
    });
    cancelDraft();
  };

  return (
    <div
      className={cn(
        "relative",
        layout === "panel"
          ? "[container-type:size] flex h-0 min-h-0 flex-1 items-center justify-center overflow-hidden p-4"
          : "block max-w-full shrink-0",
      )}
      onKeyDownCapture={(event) => {
        if (event.key !== "Escape" || !activeDraft) return;
        event.preventDefault();
        cancelDraft();
      }}
    >
      <div className={cn("relative max-w-full", layout === "panel" && "max-h-[100cqh]")}>
        <img
          alt={alt}
          className={cn(
            "block max-w-full rounded-xl object-contain",
            layout === "panel" ? "!max-h-[100cqh]" : "h-auto !max-h-[292px] w-auto",
          )}
          referrerPolicy={referrerPolicy}
          src={src}
        />
        <button
          ref={imageRef}
          type="button"
          aria-label={layout === "playground" ? `Comment on ${alt}` : "Image comment surface"}
          className={cn(
            "absolute inset-0 rounded-xl focus:outline-none focus-visible:ring-1 focus-visible:ring-token-focus-border",
            hoverPoint === null ? "cursor-interaction" : "cursor-none",
          )}
          onClick={(event) => {
            if (event.detail === 0) return;
            const point = pointFromPointer(event);
            if (!point) return;
            setHoverPoint(null);
            onDraftActiveChange?.(true);
            setStoredDraft(point);
            setDraftText("");
          }}
          onPointerMove={(event) => {
            if (activeDraft) return;
            const point = pointFromPointer(event);
            setHoverPoint(point === null ? null : { x: point.x, y: point.y });
          }}
          onPointerLeave={() => setHoverPoint(null)}
        />
        {comments.map((comment, index) =>
          comment.id === activeDraft?.id ? null : (
            <ImageCommentMarker
              key={comment.id}
              ariaLabel={`Edit comment ${index + 1}`}
              label={index + 1}
              point={comment}
              onClick={(event) => {
                const surface = event.currentTarget.parentElement;
                if (!surface || surface.clientHeight <= 0 || surface.clientWidth <= 0) return;
                const metrics = measureEditorMetrics(surface);
                if (!metrics) return;
                onDraftActiveChange?.(true);
                setStoredDraft({ ...metrics, ...comment });
                setDraftText(comment.text);
              }}
            />
          ),
        )}
        {activeDraft ? (
          <>
            <ImageCommentMarker
              draft
              draftTestId="image-comment-draft-marker"
              label={(existingIndex === -1 ? comments.length : existingIndex) + 1}
              point={activeDraft}
            />
            <div
              className="absolute overflow-hidden rounded-xl bg-token-dropdown-background/95 text-token-foreground shadow-xl ring-1 ring-token-border backdrop-blur-sm"
              style={resolveEditorPlacement(activeDraft, editingComment !== null)}
            >
              {editingComment === null ? (
                <>
                  <div
                    className={cn(
                      "absolute top-2 bottom-2 left-4",
                      draftText.trim().length === 0 ? "right-4" : "right-12",
                    )}
                  >
                    <div className="h-full min-h-0 translate-y-0.5">
                      <input
                        autoFocus
                        name="image-comment-instruction"
                        placeholder="Add a comment…"
                        value={draftText}
                        className="h-full w-full border-0 bg-transparent text-base text-token-foreground outline-none placeholder:text-token-text-tertiary"
                        onChange={(event) => setDraftText(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter") return;
                          event.preventDefault();
                          saveDraft();
                        }}
                      />
                    </div>
                  </div>
                  {draftText.trim().length > 0 ? (
                    <NodexButton
                      size="icon-sm"
                      aria-label="Add comment"
                      className="absolute right-2 bottom-2 !size-7 rounded-lg"
                      onClick={saveDraft}
                    >
                      <UpArrowIcon aria-hidden="true" className="icon-sm" />
                    </NodexButton>
                  ) : null}
                </>
              ) : (
                <>
                  <div className="absolute top-2 right-4 bottom-[52px] left-4">
                    <div className="h-full min-h-0 translate-y-0.5">
                      <textarea
                        autoFocus
                        name="image-comment-instruction"
                        value={draftText}
                        className="h-full w-full resize-none border-0 bg-transparent text-base text-token-foreground outline-none"
                        onChange={(event) => setDraftText(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return;
                          event.preventDefault();
                          saveDraft();
                        }}
                      />
                    </div>
                  </div>
                  <div className="absolute right-2 bottom-2 left-2 flex items-center justify-between">
                    <NodexButton
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Delete comment"
                      onClick={() => {
                        onDeleteComment(editingComment.id);
                        cancelDraft();
                      }}
                    >
                      <DeleteIcon aria-hidden="true" className="icon-sm" />
                    </NodexButton>
                    <div className="flex items-center gap-1.5">
                      <NodexButton variant="outline" size="sm" onClick={cancelDraft}>
                        Cancel
                      </NodexButton>
                      <NodexButton
                        size="sm"
                        disabled={draftText.trim().length === 0}
                        onClick={saveDraft}
                      >
                        Save
                      </NodexButton>
                    </div>
                  </div>
                </>
              )}
            </div>
          </>
        ) : null}
        {hoverPoint ? (
          <ImageCommentMarker
            draft
            draftTestId="image-comment-hover-marker"
            label=""
            point={hoverPoint}
          />
        ) : null}
      </div>
    </div>
  );
}
