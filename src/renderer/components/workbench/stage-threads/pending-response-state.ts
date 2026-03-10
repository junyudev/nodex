import type { CodexItemView } from "../../../lib/types";

function isUserMessageItem(item: CodexItemView): boolean {
  if (item.normalizedKind) return item.normalizedKind === "userMessage";
  return item.role === "user";
}

export function shouldShowPendingResponseRow(
  items: CodexItemView[],
  activeTurnId: string | null,
  isThreadRunning: boolean,
): boolean {
  if (!isThreadRunning || !activeTurnId) return false;

  let hasActiveTurnUserMessage = false;

  for (const item of items) {
    if (item.turnId !== activeTurnId) continue;
    if (!isUserMessageItem(item)) return false;
    hasActiveTurnUserMessage = true;
  }

  return hasActiveTurnUserMessage;
}
