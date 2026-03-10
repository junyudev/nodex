export interface PromptTextareaSizeInput {
  scrollHeight: number;
  maxHeightPx: number;
}

export interface PromptTextareaSizeResult {
  heightPx: number;
  hasOverflow: boolean;
}

export function resolvePromptTextareaSize({
  scrollHeight,
  maxHeightPx,
}: PromptTextareaSizeInput): PromptTextareaSizeResult {
  if (!Number.isFinite(scrollHeight) || scrollHeight <= 0) {
    return { heightPx: 0, hasOverflow: false };
  }

  if (!Number.isFinite(maxHeightPx) || maxHeightPx <= 0) {
    return { heightPx: scrollHeight, hasOverflow: false };
  }

  return {
    heightPx: Math.min(scrollHeight, maxHeightPx),
    hasOverflow: scrollHeight > maxHeightPx,
  };
}
