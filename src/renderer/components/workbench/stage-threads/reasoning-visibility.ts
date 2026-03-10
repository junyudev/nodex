import type { CodexItemView } from "../../../lib/types";

export function isReasoningItem(item: CodexItemView): boolean {
  if (item.normalizedKind) return item.normalizedKind === "reasoning";
  return item.type === "reasoning";
}

export function shouldRenderThreadItem(
  item: CodexItemView,
  hideThinkingWhenDone: boolean,
  activeTurnId: string | null,
): boolean {
  if (!isReasoningItem(item)) return true;
  if (!hideThinkingWhenDone) return true;

  if (item.status) {
    return item.status === "inProgress";
  }

  if (!activeTurnId) return false;
  return item.turnId === activeTurnId;
}
