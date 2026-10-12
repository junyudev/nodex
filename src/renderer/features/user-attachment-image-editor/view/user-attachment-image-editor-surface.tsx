import { useGeneratedImageCollectionGroups } from "../adapters/use-generated-image-collection-groups";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Ref,
} from "react";
import { flushSync } from "react-dom";
import { useReducedMotion } from "motion/react";
import { ImageCanvasViewIcon, ImageFocusedViewIcon } from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import { NodexPopover, NodexPopoverAnchor, NodexPopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  getImageEditComposerDraftSnapshot,
  replaceImageEditComposerDraft,
  requestImageEditComposerSubmit,
  subscribeImageEditComposerDraft,
  type ImageEditComposerAttachment,
  type ImageEditComposerDraftSnapshot,
} from "@/lib/image-edit-composer-channel";
import { trackImageToolOpen, trackImageView } from "../analytics/image-editor-analytics";
import { useImageEditSubmission } from "../adapters/use-image-edit-submission";
import {
  getGeneratedImageLiveCollectionSnapshot,
  replaceGeneratedImageCanonicalGroups,
  subscribeGeneratedImageLiveCollections,
} from "../adapters/generated-image-collection-store";
import { buildCommentSubmissionIntent } from "../model/image-edit-submission";
import {
  createGeneratedImageViewTransitionPlan,
  isUsableGeneratedImageTransitionRect,
  readImageEditorWindowZoom,
  scrollGeneratedImageTransitionTargetIntoView,
} from "../model/generated-image-view-transition";
import {
  captureGeneratedImageOptimisticFocus,
  OPTIMISTIC_IMAGE_EDIT_PREFIX,
  reconcileGeneratedSelection,
  resolveGeneratedActiveImageId,
  resolveGeneratedImageOptimisticFocus,
  type GeneratedImageOptimisticFocus,
  type GeneratedImageReplacement,
} from "../model/generated-image-collection";
import type {
  EditableImageDescriptor,
  GeneratedImageDescriptor,
  ImageComment,
  ImageEditorView,
  NormalizedUserAttachmentImageEditorOptions,
  PlaygroundTool,
  SingleImageTool,
} from "../model/types";
import {
  GeneratedImagePlayground,
  type GeneratedImagePlaygroundGroup,
} from "./generated-image-playground";
import { GeneratedImageRail } from "./generated-image-rail";
import { SingleImageEditor } from "./single-image-editor";

const CANVAS_COACHMARK_STORAGE_KEY = "has-dismissed-image-canvas-view-coachmark-v1";

export interface UserAttachmentImageEditorSurfaceProps {
  fullWidth?: boolean;
  options: NormalizedUserAttachmentImageEditorOptions;
  onStateChange?: (state: {
    readonly activeImageId: string;
    readonly playgroundTool: PlaygroundTool;
    readonly view: ImageEditorView;
  }) => void;
  onTitleChange?: (title: string) => void;
}

function toGeneratedImage(image: EditableImageDescriptor, index: number): GeneratedImageDescriptor {
  if ("groupId" in image && "generatedOrdinal" in image && "status" in image) {
    return image as GeneratedImageDescriptor;
  }
  return {
    ...image,
    source: "generated",
    generatedOrdinal: index + 1,
    groupId: image.turnId ?? "initial-generated-images",
    status: image.loading ? "loading" : image.error ? "failed" : "ready",
  };
}

function groupGeneratedImages(
  images: readonly GeneratedImageDescriptor[],
): GeneratedImagePlaygroundGroup[] {
  const groups = new Map<string, GeneratedImagePlaygroundGroup>();
  for (const image of images) {
    const current = groups.get(image.groupId);
    if (current) {
      groups.set(image.groupId, {
        ...current,
        images: [...current.images, image],
      });
      continue;
    }
    groups.set(image.groupId, {
      id: image.groupId,
      images: [image],
      turnStartedAtMs: image.turnStartedAtMs ?? null,
    });
  }
  return [...groups.values()];
}

function resolveEditorAttachmentSource(
  image: EditableImageDescriptor,
  resolvedSources: Readonly<Record<string, string>>,
): string {
  return (
    resolvedSources[image.id] ??
    image.dataUrl ??
    image.localPath ??
    image.downloadSrc ??
    image.previewSrc ??
    image.attachmentSrc ??
    image.src
  );
}

function makeComposerAttachment(
  image: EditableImageDescriptor,
  comments: readonly ImageComment[],
  resolvedSources: Readonly<Record<string, string>>,
): ImageEditComposerAttachment {
  const source = resolveEditorAttachmentSource(image, resolvedSources);
  return {
    asset: {
      hostId: image.hostId?.trim() || null,
      localPath: image.localPath?.trim() || null,
      managedSource: image.managedSource?.trim() || null,
      src: source,
    },
    comments,
    filename: image.alt.trim() || `generated-image-${image.id}`,
    id: image.attachmentId?.trim() || makeComposerAttachmentId(image.id),
    imageSource: image.source,
  };
}

function makeComposerAttachmentId(imageId: string): string {
  return imageId.startsWith("image-playground:") ? imageId : `image-playground:${imageId}`;
}

function restoreCommentsFromComposerDraft(
  draft: ImageEditComposerDraftSnapshot,
  images: readonly EditableImageDescriptor[],
): Readonly<Record<string, readonly ImageComment[]>> {
  const commentsByImageId: Record<string, readonly ImageComment[]> = {};
  for (const image of images) {
    const attachment = draft.attachments.find(
      (candidate) => candidate.id === makeComposerAttachmentId(image.id),
    );
    if (attachment?.comments.length) {
      commentsByImageId[image.id] = attachment.comments;
    }
  }
  return commentsByImageId;
}

function restoreSelectionFromComposerDraft(
  draft: ImageEditComposerDraftSnapshot,
  images: readonly EditableImageDescriptor[],
): ReadonlySet<string> {
  const attachmentIds = new Set(draft.attachments.map((attachment) => attachment.id));
  return new Set(
    images.flatMap((image) =>
      attachmentIds.has(makeComposerAttachmentId(image.id)) ? [image.id] : [],
    ),
  );
}

function composerAttachmentsMatch(
  left: readonly ImageEditComposerAttachment[],
  right: readonly ImageEditComposerAttachment[],
): boolean {
  return (
    left.length === right.length &&
    left.every((attachment, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        attachment.id === candidate.id &&
        attachment.filename === candidate.filename &&
        attachment.imageSource === candidate.imageSource &&
        attachment.asset.src === candidate.asset.src &&
        attachment.asset.hostId === candidate.asset.hostId &&
        attachment.asset.localPath === candidate.asset.localPath &&
        attachment.asset.managedSource === candidate.asset.managedSource &&
        attachment.comments.length === candidate.comments.length &&
        attachment.comments.every((comment, commentIndex) => {
          const other = candidate.comments[commentIndex];
          return (
            other !== undefined &&
            comment.id === other.id &&
            comment.text === other.text &&
            comment.x === other.x &&
            comment.y === other.y
          );
        })
      );
    })
  );
}

function composerDraftMatches(
  draft: ImageEditComposerDraftSnapshot,
  input: {
    attachments: readonly ImageEditComposerAttachment[];
    mode: "comment" | "selection" | null;
  },
): boolean {
  return (
    draft.mode === input.mode && composerAttachmentsMatch(draft.attachments, input.attachments)
  );
}

function ImageViewToggle({
  showCoachmark,
  view,
  onDismissCoachmark,
  onViewChange,
}: {
  showCoachmark: boolean;
  view: ImageEditorView;
  onDismissCoachmark: () => void;
  onViewChange: (view: ImageEditorView) => void;
}) {
  const control = (
    <div
      role="toolbar"
      aria-label="Image view"
      className="flex rounded-lg bg-token-main-surface-primary p-1 shadow-sm ring-1 ring-token-border"
    >
      <NodexButton
        variant={view === "single" ? "secondary" : "ghost"}
        size="icon-xs"
        aria-label="Focused view"
        aria-pressed={view === "single"}
        className="!size-6 rounded-md"
        onClick={() => onViewChange("single")}
      >
        <ImageFocusedViewIcon aria-hidden="true" className="size-4" />
      </NodexButton>
      <NodexButton
        variant={view === "playground" ? "secondary" : "ghost"}
        size="icon-xs"
        aria-label="Canvas view"
        aria-pressed={view === "playground"}
        className="!size-6 rounded-md"
        onClick={() => onViewChange("playground")}
      >
        <ImageCanvasViewIcon aria-hidden="true" className="size-4" />
      </NodexButton>
    </div>
  );

  const coachmarkLabel = view === "single" ? "Try Canvas view" : "Try focused view";

  return (
    <div className="absolute top-2 left-2 z-40">
      <NodexPopover
        open={showCoachmark}
        onOpenChange={(open) => {
          if (!open) onDismissCoachmark();
        }}
      >
        <NodexPopoverAnchor>{control}</NodexPopoverAnchor>
        <NodexPopoverContent
          align="start"
          aria-label={coachmarkLabel}
          className="w-60 gap-0 p-3 text-sm"
          side="right"
          sideOffset={12}
          initialFocus={false}
        >
          <div className="font-medium text-token-foreground">{coachmarkLabel}</div>
          <p className="mt-1 text-token-text-secondary">
            Switch between a focused image and all generated images
          </p>
          <NodexButton
            variant="ghost"
            size="sm"
            className="mt-2 self-start"
            onClick={onDismissCoachmark}
          >
            Dismiss
          </NodexButton>
        </NodexPopoverContent>
      </NodexPopover>
    </div>
  );
}

export function UserAttachmentImageEditorSurface({
  fullWidth = false,
  options,
  onStateChange,
  onTitleChange,
}: UserAttachmentImageEditorSurfaceProps) {
  const reducedMotion = Boolean(useReducedMotion());
  const canonicalGeneratedGroups = useGeneratedImageCollectionGroups(options.threadId);
  const getLiveCollectionSnapshot = useCallback(
    () => getGeneratedImageLiveCollectionSnapshot(options.threadId ?? ""),
    [options.threadId],
  );
  const liveCollection = useSyncExternalStore(
    subscribeGeneratedImageLiveCollections,
    getLiveCollectionSnapshot,
    getLiveCollectionSnapshot,
  );
  useEffect(() => {
    if (!options.threadId) return undefined;
    return replaceGeneratedImageCanonicalGroups(options.threadId, canonicalGeneratedGroups);
  }, [canonicalGeneratedGroups, options.threadId]);
  const generatedImages = useMemo(() => {
    const fallbackImages = (options.generatedImages ?? options.images).map(toGeneratedImage);
    if (liveCollection.images.length === 0) return fallbackImages;
    const hasCanonicalOrMountedGroup = liveCollection.groups.some(
      (group) => !group.id.startsWith(OPTIMISTIC_IMAGE_EDIT_PREFIX),
    );
    return hasCanonicalOrMountedGroup
      ? liveCollection.images
      : [...fallbackImages, ...liveCollection.images];
  }, [liveCollection.groups, liveCollection.images, options.generatedImages, options.images]);
  const generatedGroups = useMemo(() => groupGeneratedImages(generatedImages), [generatedImages]);
  const canUsePlayground = options.imageSource === "generated" && generatedImages.length > 0;
  const editorImages = options.imageSource === "generated" ? generatedImages : options.images;
  const composerChannelId = options.composerTarget?.channelId ?? options.threadId ?? "";
  const getComposerDraftSnapshot = useCallback(
    () => getImageEditComposerDraftSnapshot(composerChannelId),
    [composerChannelId],
  );
  const subscribeComposerDraft = useCallback(
    (listener: () => void) => subscribeImageEditComposerDraft(composerChannelId, listener),
    [composerChannelId],
  );
  const composerDraft = useSyncExternalStore(
    subscribeComposerDraft,
    getComposerDraftSnapshot,
    getComposerDraftSnapshot,
  );
  const [activeImageId, setActiveImageId] = useState(options.initialImageId);
  const [view, setView] = useState<ImageEditorView>(
    canUsePlayground ? options.initialView : "single",
  );
  const [singleTool, setSingleTool] = useState<SingleImageTool>(() =>
    composerDraft.mode === "comment" && options.initialView === "single" ? "comment" : "navigate",
  );
  const [playgroundTool, setPlaygroundTool] = useState<PlaygroundTool>(
    composerDraft.mode === "comment" && options.initialView === "playground"
      ? "comment"
      : options.initialPlaygroundTool,
  );
  const [playgroundZoomPercent, setPlaygroundZoomPercent] = useState(100);
  const [selectedImageIds, setSelectedImageIds] = useState<ReadonlySet<string>>(() => {
    const restored = restoreSelectionFromComposerDraft(composerDraft, editorImages);
    return composerDraft.mode === "selection" && restored.size > 0
      ? restored
      : new Set([options.initialImageId]);
  });
  const [commentsByImageId, setCommentsByImageId] = useState<
    Readonly<Record<string, readonly ImageComment[]>>
  >(() => restoreCommentsFromComposerDraft(composerDraft, editorImages));
  const [resolvedSources, setResolvedSources] = useState<Readonly<Record<string, string>>>({});
  const [activeDraftImageId, setActiveDraftImageId] = useState<string | null>(null);
  const [isViewTransitioning, setIsViewTransitioning] = useState(false);
  const [coachmarkReady, setCoachmarkReady] = useState(false);
  const [coachmarkDismissed, setCoachmarkDismissed] = useState(
    () =>
      typeof window === "undefined" ||
      window.localStorage.getItem(CANVAS_COACHMARK_STORAGE_KEY) === "true",
  );
  const focusedElementRef = useRef<HTMLElement | null>(null);
  const viewAnimationRef = useRef<Animation | null>(null);
  const previousGeneratedImagesRef = useRef(generatedImages);
  const previousGeneratedGroupsRef = useRef(generatedGroups);
  const optimisticFocusRef = useRef<GeneratedImageOptimisticFocus | null>(null);
  const activeImageIdRef = useRef(activeImageId);
  activeImageIdRef.current = activeImageId;
  const didTrackInitialViewRef = useRef(false);
  const observedComposerRevisionRef = useRef(composerDraft.revision);
  const skipComposerPublishRevisionRef = useRef<number | null>(null);
  const submission = useImageEditSubmission({
    composerTarget: options.composerTarget,
    projectId: options.projectId,
    threadId: options.threadId,
  });
  const activeImage =
    editorImages.find((image) => image.id === activeImageId) ??
    editorImages.find((image) => !image.loading) ??
    editorImages[0] ??
    null;
  const activeGeneratedImage =
    generatedImages.find((image) => image.id === activeImageId) ?? generatedImages[0] ?? null;
  const hasImageRail = canUsePlayground && fullWidth && generatedImages.length > 1;
  const publishStateChange = useEffectEvent(
    (state: {
      readonly activeImageId: string;
      readonly playgroundTool: PlaygroundTool;
      readonly view: ImageEditorView;
    }) => {
      onStateChange?.(state);
    },
  );

  useEffect(() => {
    if (!activeImage) return;
    onTitleChange?.(activeImage.tabTitle ?? options.title);
  }, [activeImage, onTitleChange, options.title]);

  useEffect(() => {
    publishStateChange({
      activeImageId,
      playgroundTool,
      view,
    });
  }, [activeImageId, playgroundTool, view]);

  useEffect(() => {
    if (options.imageSource !== "generated") return;
    const previousImages = previousGeneratedImagesRef.current;
    const previousGroups = previousGeneratedGroupsRef.current;
    previousGeneratedImagesRef.current = generatedImages;
    previousGeneratedGroupsRef.current = generatedGroups;
    const nextIds = new Set(generatedImages.map((image) => image.id));
    const previousIds = new Set(previousImages.map((image) => image.id));
    const removedOptimistic = previousImages.filter(
      (image) => image.id.startsWith(OPTIMISTIC_IMAGE_EDIT_PREFIX) && !nextIds.has(image.id),
    );
    const addedReady = generatedImages.filter(
      (image) => !previousIds.has(image.id) && image.status === "ready",
    );
    const addedOptimistic = generatedImages.findLast(
      (image) => !previousIds.has(image.id) && image.id.startsWith(OPTIMISTIC_IMAGE_EDIT_PREFIX),
    );
    if (addedOptimistic) {
      optimisticFocusRef.current = captureGeneratedImageOptimisticFocus({
        groups: previousGroups,
        optimisticImageId: addedOptimistic.id,
        previousImageId: activeImageIdRef.current,
      });
    }
    const focus = optimisticFocusRef.current;
    const resolvedFocusImageId =
      focus && removedOptimistic.some((image) => image.id === focus.optimisticImageId)
        ? resolveGeneratedImageOptimisticFocus({ focus, groups: generatedGroups })
        : null;
    if (focus && removedOptimistic.some((image) => image.id === focus.optimisticImageId)) {
      optimisticFocusRef.current = null;
    }
    const optimistic =
      focus && resolvedFocusImageId
        ? removedOptimistic.find((image) => image.id === focus.optimisticImageId)
        : removedOptimistic.length === 1
          ? removedOptimistic[0]
          : undefined;
    const replacementImage =
      optimistic && resolvedFocusImageId && !previousIds.has(resolvedFocusImageId)
        ? generatedImages.find((image) => image.id === resolvedFocusImageId)
        : !focus && optimistic
          ? addedReady.at(-1)
          : undefined;
    const replacement: GeneratedImageReplacement | undefined =
      optimistic && replacementImage
        ? {
            optimisticImageId: optimistic.id,
            replacementImageId: replacementImage.id,
          }
        : undefined;

    setActiveImageId(
      (current) =>
        resolveGeneratedActiveImageId({
          currentActiveImageId: addedOptimistic?.id ?? current,
          images: generatedImages,
          preferredImageId: resolvedFocusImageId,
          replacement,
        }) ?? current,
    );
    if (addedOptimistic) {
      setSelectedImageIds(new Set());
      setActiveDraftImageId(null);
    }
    setSelectedImageIds((current) => {
      const next = reconcileGeneratedSelection({
        images: generatedImages,
        replacement,
        selectedImageIds: [...current],
      });
      return next.length === current.size && next.every((id) => current.has(id))
        ? current
        : new Set(next);
    });
    if (replacement) {
      setCommentsByImageId((current) => {
        const optimisticComments = current[replacement.optimisticImageId];
        if (!optimisticComments) return current;
        const next = { ...current };
        delete next[replacement.optimisticImageId];
        next[replacement.replacementImageId] = optimisticComments;
        return next;
      });
    }
  }, [generatedGroups, generatedImages, options.imageSource]);

  useEffect(() => {
    trackImageView({
      availableImageCount: options.availableImageCount,
      entrypoint: didTrackInitialViewRef.current ? "view_toggle" : options.entrypoint,
      imageSource: options.imageSource,
      view: view === "playground" ? "canvas" : "single",
    });
    didTrackInitialViewRef.current = true;
  }, [options.availableImageCount, options.entrypoint, options.imageSource, view]);

  useEffect(() => {
    if (!canUsePlayground || coachmarkDismissed) return undefined;
    const timeout = window.setTimeout(() => setCoachmarkReady(true), reducedMotion ? 0 : 450);
    return () => window.clearTimeout(timeout);
  }, [canUsePlayground, coachmarkDismissed, reducedMotion]);

  useEffect(
    () => () => {
      viewAnimationRef.current?.cancel();
    },
    [],
  );

  useEffect(() => {
    if (composerDraft.revision === observedComposerRevisionRef.current) return;
    observedComposerRevisionRef.current = composerDraft.revision;
    skipComposerPublishRevisionRef.current = composerDraft.revision;

    setCommentsByImageId(restoreCommentsFromComposerDraft(composerDraft, editorImages));
    if (composerDraft.mode === "selection") {
      setSelectedImageIds(restoreSelectionFromComposerDraft(composerDraft, editorImages));
    }
    if (composerDraft.mode === "comment") {
      if (view === "playground") setPlaygroundTool("comment");
      else setSingleTool("comment");
      return;
    }
    setActiveDraftImageId(null);
    setSingleTool((current) => (current === "comment" ? "navigate" : current));
    setPlaygroundTool((current) => (current === "comment" ? "navigate" : current));
  }, [composerDraft, editorImages, view]);

  useEffect(() => {
    if (!composerChannelId || !activeImage) return;
    let mode: "comment" | "selection" | null = null;
    let attachments: readonly ImageEditComposerAttachment[] = [];

    if (view === "single" && singleTool === "comment") {
      mode = "comment";
      attachments = [
        makeComposerAttachment(
          activeImage,
          commentsByImageId[activeImage.id] ?? [],
          resolvedSources,
        ),
      ];
    } else if (view === "playground" && playgroundTool === "comment") {
      mode = "comment";
      attachments = generatedImages.flatMap((image) => {
        const comments = commentsByImageId[image.id] ?? [];
        return comments.length === 0
          ? []
          : [makeComposerAttachment(image, comments, resolvedSources)];
      });
    } else if (options.imageSource === "generated" && submission.supportsImageInputs) {
      attachments = generatedImages.flatMap((image) =>
        selectedImageIds.has(image.id) && image.status === "ready"
          ? [makeComposerAttachment(image, [], resolvedSources)]
          : [],
      );
      mode = attachments.length > 0 ? "selection" : null;
    }

    if (skipComposerPublishRevisionRef.current === composerDraft.revision) {
      skipComposerPublishRevisionRef.current = null;
      return;
    }
    if (composerDraftMatches(composerDraft, { attachments, mode })) return;
    replaceImageEditComposerDraft(composerChannelId, { attachments, mode });
    observedComposerRevisionRef.current =
      getImageEditComposerDraftSnapshot(composerChannelId).revision;
  }, [
    activeImage,
    commentsByImageId,
    composerChannelId,
    composerDraft,
    generatedImages,
    options.imageSource,
    playgroundTool,
    resolvedSources,
    selectedImageIds,
    singleTool,
    submission.supportsImageInputs,
    view,
  ]);

  const recordResolvedSource = useCallback((imageId: string, submissionSrc: string) => {
    if (!submissionSrc.startsWith("data:image/")) return;
    setResolvedSources((current) =>
      current[imageId] === submissionSrc ? current : { ...current, [imageId]: submissionSrc },
    );
  }, []);

  const setFocusedSingleImageRef = useCallback((element: HTMLImageElement | null) => {
    focusedElementRef.current = element;
  }, []);
  const setFocusedPlaygroundImageRef = useCallback((element: HTMLButtonElement | null) => {
    focusedElementRef.current = element;
  }, []);

  const changeView = (nextView: ImageEditorView) => {
    if (nextView === view || !canUsePlayground) return;
    const nextPlaygroundTool = nextView === "single" ? "navigate" : playgroundTool;
    viewAnimationRef.current?.cancel();
    const before = focusedElementRef.current?.getBoundingClientRect() ?? null;
    setIsViewTransitioning(true);
    flushSync(() => {
      if (nextView === "single") {
        setPlaygroundTool("navigate");
        setActiveDraftImageId(null);
      }
      setView(nextView);
      onStateChange?.({
        activeImageId,
        playgroundTool: nextPlaygroundTool,
        view: nextView,
      });
    });
    const element = focusedElementRef.current;
    if (nextView === "playground" && element) {
      scrollGeneratedImageTransitionTargetIntoView(element);
    }
    const after = element?.getBoundingClientRect() ?? null;
    if (
      reducedMotion ||
      !isUsableGeneratedImageTransitionRect(before) ||
      !isUsableGeneratedImageTransitionRect(after) ||
      !element ||
      typeof element.animate !== "function"
    ) {
      setIsViewTransitioning(false);
      return;
    }
    const plan = createGeneratedImageViewTransitionPlan({
      after,
      before,
      canvasZoomPercent: playgroundZoomPercent,
      enteringCanvas: nextView === "playground",
      windowZoom: readImageEditorWindowZoom(element),
    });
    const animation = element.animate(plan.keyframes, plan.options);
    viewAnimationRef.current = animation;
    const finish = () => {
      if (viewAnimationRef.current !== animation) return;
      viewAnimationRef.current = null;
      animation.oncancel = null;
      animation.onfinish = null;
      setIsViewTransitioning(false);
      animation.cancel();
    };
    animation.oncancel = finish;
    animation.onfinish = finish;
  };

  if (!activeImage || !activeGeneratedImage) {
    return (
      <div
        role="status"
        className="flex h-full min-h-0 items-center justify-center bg-token-bg-primary text-sm text-token-text-tertiary"
      >
        No image available
      </div>
    );
  }

  const withResolvedSource = (image: EditableImageDescriptor): EditableImageDescriptor => {
    const source = resolveEditorAttachmentSource(image, resolvedSources);
    return source.startsWith("data:image/") ? { ...image, dataUrl: source } : image;
  };

  const renderSingle = (image: EditableImageDescriptor) => (
    <SingleImageEditor
      key={image.id}
      comments={commentsByImageId[image.id] ?? []}
      entrypoint={options.entrypoint}
      hasImageRail={hasImageRail}
      image={withResolvedSource(image)}
      imageRef={setFocusedSingleImageRef as Ref<HTMLImageElement>}
      isSubmitting={submission.isSubmitting}
      onCommentsChange={(comments) => {
        setCommentsByImageId((current) => ({ ...current, [image.id]: comments }));
      }}
      onResolvedSource={(displaySrc) => recordResolvedSource(image.id, displaySrc)}
      onRequestCommentSubmit={
        composerChannelId
          ? () => requestImageEditComposerSubmit(composerChannelId, { source: "single" })
          : undefined
      }
      onSubmitIntent={submission.submit}
      onToolChange={(tool) => {
        if (tool !== "navigate" && !submission.supportsImageInputs) {
          submission.notifyImageInputUnsupported(tool === "comment" ? "comment" : "edit");
          return;
        }
        setSingleTool(tool);
        if (tool === "navigate") return;
        trackImageToolOpen({
          imageSource: image.source,
          mode: tool,
          view: "single",
        });
      }}
      tool={singleTool}
    />
  );

  const content =
    view === "playground" ? (
      <GeneratedImagePlayground
        activeDraftImageId={activeDraftImageId}
        activeImageId={activeGeneratedImage.id}
        commentsByImageId={commentsByImageId}
        focusedImageRef={setFocusedPlaygroundImageRef}
        groups={generatedGroups}
        isSubmitting={submission.isSubmitting}
        isViewTransitioning={isViewTransitioning && !reducedMotion}
        selectedImageIds={selectedImageIds}
        tool={playgroundTool}
        zoomPercent={playgroundZoomPercent}
        onActiveDraftImageIdChange={setActiveDraftImageId}
        onCommentsChange={(imageId, comments) => {
          setCommentsByImageId((current) => ({ ...current, [imageId]: comments }));
        }}
        onImageActivate={(image, displaySrc) => {
          recordResolvedSource(image.id, displaySrc);
          if (playgroundTool === "navigate") {
            setActiveImageId(image.id);
            setSelectedImageIds(new Set([image.id]));
            return;
          }
          if (playgroundTool !== "select") return;
          if (!submission.supportsImageInputs) {
            submission.notifyImageInputUnsupported("select");
            return;
          }
          setSelectedImageIds((current) => {
            const next = new Set(current);
            if (next.has(image.id)) next.delete(image.id);
            else next.add(image.id);
            return next;
          });
        }}
        onResolvedSource={recordResolvedSource}
        onSendComments={() => {
          const commentedImages = generatedImages.flatMap((image) => {
            const comments = commentsByImageId[image.id] ?? [];
            return comments.length === 0 ? [] : [{ comments, image: withResolvedSource(image) }];
          });
          void (async () => {
            const composerResult = composerChannelId
              ? await requestImageEditComposerSubmit(composerChannelId, { source: "canvas" })
              : { status: "unavailable" as const, reason: "composer-unmounted" as const };
            if (composerResult.status === "submitted" || composerResult.status === "queued")
              return true;
            if (composerResult.status === "failed") return false;
            return submission.submit(
              buildCommentSubmissionIntent({
                commentedImages,
                entrypoint: options.entrypoint,
              }),
            );
          })().then((submitted) => {
            if (!submitted) return;
            setCommentsByImageId({});
            setPlaygroundTool("navigate");
            setActiveDraftImageId(null);
          });
        }}
        onToolChange={(tool) => {
          if (tool !== "navigate" && !submission.supportsImageInputs) {
            submission.notifyImageInputUnsupported(tool === "comment" ? "comment" : "select");
            return;
          }
          const previousTool = playgroundTool;
          setPlaygroundTool(tool);
          if (previousTool === "comment" && tool !== "comment") {
            setCommentsByImageId({});
          }
          if (tool !== "navigate") {
            trackImageToolOpen({
              imageSource: "generated",
              mode: tool === "select" ? "select" : "comment",
              view: "canvas",
            });
          }
          if (tool !== "comment") setActiveDraftImageId(null);
          if (tool !== "navigate") return;
          const selected = [...selectedImageIds].at(-1) ?? activeGeneratedImage.id;
          setActiveImageId(selected);
          setSelectedImageIds(new Set([selected]));
        }}
        onZoomPercentChange={setPlaygroundZoomPercent}
      />
    ) : hasImageRail ? (
      <div className="flex h-full min-h-0">
        <GeneratedImageRail
          activeId={activeImage.id}
          autoScrollImageId={
            activeImage.id.startsWith(OPTIMISTIC_IMAGE_EDIT_PREFIX) ? activeImage.id : null
          }
          images={generatedImages}
          onSelect={(image) => {
            setActiveImageId(image.id);
            setSelectedImageIds(new Set([image.id]));
          }}
        />
        <div className="min-w-0 flex-1">{renderSingle(activeImage)}</div>
      </div>
    ) : (
      renderSingle(activeImage)
    );

  return (
    <div
      className={cn(
        "relative h-full min-h-0 min-w-0 w-full bg-token-bg-primary",
        isViewTransitioning && "pointer-events-none",
      )}
    >
      {canUsePlayground ? (
        <ImageViewToggle
          showCoachmark={coachmarkReady && !coachmarkDismissed}
          view={view}
          onDismissCoachmark={() => {
            setCoachmarkDismissed(true);
            window.localStorage.setItem(CANVAS_COACHMARK_STORAGE_KEY, "true");
          }}
          onViewChange={changeView}
        />
      ) : null}
      {content}
    </div>
  );
}
