import type { CodexConversationItem } from "../../../lib/types";

export interface GeneratedImageOutputState {
  visibleCompletedItems: CodexConversationItem[];
  pendingImageCount: number;
  shouldRender: boolean;
}
function getPathExtension(path: string): string {
  const withoutQueryOrFragment = path.split(/[?#]/u, 1)[0] ?? path;
  const extension = /\.([^.\\/]+)$/u.exec(withoutQueryOrFragment)?.[1];
  return extension?.toLowerCase() ?? "";
}

export function isGeneratedImagePending(src: string | null, status: string): boolean {
  return src === null && (status === "in_progress" || status === "inProgress");
}

function isPendingGeneratedImage(item: CodexConversationItem): boolean {
  if (!item.generatedImage) return false;
  return isGeneratedImagePending(item.generatedImage.src, item.generatedImage.status);
}

/** Exact `US`: presentation outputs suppress completed images, not pending work. */
export function resolveGeneratedImageOutputState(input: {
  items: readonly CodexConversationItem[];
  endResourcePaths: readonly string[];
  isTurnInProgress: boolean;
}): GeneratedImageOutputState {
  const completedItems = input.items.filter((item) => item.generatedImage?.src != null);
  const visibleCompletedItems = input.endResourcePaths.some(
    (path) => getPathExtension(path) === "pptx",
  )
    ? []
    : completedItems;
  const pendingImageCount = input.isTurnInProgress
    ? input.items.filter(isPendingGeneratedImage).length
    : 0;

  return {
    visibleCompletedItems,
    pendingImageCount,
    shouldRender: visibleCompletedItems.length > 0 || pendingImageCount > 0,
  };
}
