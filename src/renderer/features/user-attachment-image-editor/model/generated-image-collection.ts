import type { GeneratedImageCollectionState } from "./types";
import type { GeneratedImageDescriptor } from "@/lib/content-image";

export const IMAGE_PLAYGROUND_ATTACHMENT_PREFIX = "image-playground:";
export const OPTIMISTIC_IMAGE_EDIT_PREFIX = "optimistic-image-edit:";

export interface GeneratedImageReplacement {
  optimisticImageId: string;
  replacementImageId: string;
}

export interface GeneratedImageFocusGroup {
  readonly id: string;
  readonly images: readonly GeneratedImageDescriptor[];
}

export interface GeneratedImageOptimisticFocus {
  readonly liveTailGroupId: string | null;
  readonly liveTailImageCount: number;
  readonly optimisticImageId: string;
  readonly previousImageId: string | null;
}

function dedupeGeneratedImages(
  images: readonly GeneratedImageDescriptor[],
): readonly GeneratedImageDescriptor[] {
  const indexesById = new Map<string, number>();
  const result: GeneratedImageDescriptor[] = [];

  for (const image of images) {
    const existingIndex = indexesById.get(image.id);
    if (existingIndex === undefined) {
      indexesById.set(image.id, result.length);
      result.push(image);
      continue;
    }

    result[existingIndex] = image;
  }

  return result;
}

function isAvailableGeneratedImage(image: GeneratedImageDescriptor): boolean {
  return image.status === "ready" && image.loading !== true && image.error === undefined;
}

export function captureGeneratedImageOptimisticFocus(args: {
  groups: readonly GeneratedImageFocusGroup[];
  optimisticImageId: string;
  previousImageId: string | null;
}): GeneratedImageOptimisticFocus {
  const liveTail = args.groups.findLast(
    (group) => !group.id.startsWith(OPTIMISTIC_IMAGE_EDIT_PREFIX),
  );
  return {
    liveTailGroupId: liveTail?.id ?? null,
    liveTailImageCount: liveTail?.images.length ?? 0,
    optimisticImageId: args.optimisticImageId,
    previousImageId: args.previousImageId,
  };
}

/**
 * Resolves an optimistic edit against its original live tail. This keeps the
 * focused image stable when older history mounts or timestamps are equal.
 */
export function resolveGeneratedImageOptimisticFocus(args: {
  focus: GeneratedImageOptimisticFocus;
  groups: readonly GeneratedImageFocusGroup[];
}): string | null {
  if (
    args.groups.some((group) =>
      group.images.some((image) => image.id === args.focus.optimisticImageId),
    )
  ) {
    return args.focus.optimisticImageId;
  }

  const liveTail = args.groups.findLast(
    (group) => !group.id.startsWith(OPTIMISTIC_IMAGE_EDIT_PREFIX),
  );
  const liveTailReplacement =
    liveTail?.id === args.focus.liveTailGroupId
      ? liveTail.images[args.focus.liveTailImageCount]
      : liveTail?.images.at(-1);
  if (liveTailReplacement && isAvailableGeneratedImage(liveTailReplacement)) {
    return liveTailReplacement.id;
  }

  const availableImages = args.groups
    .flatMap((group) => group.images)
    .filter(isAvailableGeneratedImage);
  return (
    availableImages.find((image) => image.id === args.focus.previousImageId)?.id ??
    availableImages.at(-1)?.id ??
    null
  );
}

export function resolveGeneratedActiveImageId(args: {
  currentActiveImageId: string | null;
  images: readonly GeneratedImageDescriptor[];
  preferredImageId?: string | null;
  replacement?: GeneratedImageReplacement;
}): string | null {
  if (args.images.length === 0) return null;

  const imageIds = new Set(args.images.map((image) => image.id));
  if (args.preferredImageId !== undefined && args.preferredImageId !== null) {
    if (imageIds.has(args.preferredImageId)) return args.preferredImageId;
  }

  if (
    args.replacement !== undefined &&
    args.currentActiveImageId === args.replacement.optimisticImageId &&
    imageIds.has(args.replacement.replacementImageId)
  ) {
    return args.replacement.replacementImageId;
  }

  if (args.currentActiveImageId !== null && imageIds.has(args.currentActiveImageId)) {
    return args.currentActiveImageId;
  }

  return args.images.findLast(isAvailableGeneratedImage)?.id ?? args.images.at(-1)?.id ?? null;
}

export function reconcileGeneratedSelection(args: {
  images: readonly GeneratedImageDescriptor[];
  replacement?: GeneratedImageReplacement;
  selectedImageIds: readonly string[];
}): readonly string[] {
  const imageIds = new Set(args.images.map((image) => image.id));
  const result: string[] = [];
  const seen = new Set<string>();

  for (const selectedImageId of args.selectedImageIds) {
    const nextId =
      args.replacement !== undefined && selectedImageId === args.replacement.optimisticImageId
        ? args.replacement.replacementImageId
        : selectedImageId;
    if (!imageIds.has(nextId) || seen.has(nextId)) continue;
    seen.add(nextId);
    result.push(nextId);
  }

  return result;
}

export function selectGeneratedImage(args: {
  imageId: string;
  mode: "single" | "multiple";
  selectedImageIds: readonly string[];
}): readonly string[] {
  if (args.mode === "single") return [args.imageId];

  const isSelected = args.selectedImageIds.includes(args.imageId);
  if (isSelected) {
    return args.selectedImageIds.filter((imageId) => imageId !== args.imageId);
  }
  return [...args.selectedImageIds, args.imageId];
}

/** Reconciles canonical, live-tail, and optimistic images without leaking stale selection. */
export function reconcileGeneratedImageCollection(args: {
  nextImages: readonly GeneratedImageDescriptor[];
  preferredImageId?: string | null;
  previous: GeneratedImageCollectionState;
  replacement?: GeneratedImageReplacement;
}): GeneratedImageCollectionState {
  const images = dedupeGeneratedImages(args.nextImages);
  const activeImageId = resolveGeneratedActiveImageId({
    currentActiveImageId: args.previous.activeImageId,
    images,
    preferredImageId: args.preferredImageId,
    replacement: args.replacement,
  });
  const selectedImageIds = reconcileGeneratedSelection({
    images,
    replacement: args.replacement,
    selectedImageIds: args.previous.selectedImageIds,
  });

  return {
    activeImageId,
    images,
    selectedImageIds,
  };
}
