import type { CodexItemView } from "./types";

function normalizeUserMessageText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

type CodexItemPrimaryIdentityInput = Pick<
  CodexItemView,
  "turnId" | "itemId"
>;

type CodexItemTextIdentityInput = Pick<
  CodexItemView,
  "turnId" | "itemId" | "normalizedKind" | "markdownText"
>;

function isTextIdentityKind(kind: string | undefined): boolean {
  return (
    kind === "userMessage" ||
    kind === "assistantMessage" ||
    kind === "plan" ||
    kind === "reasoning"
  );
}

export function resolveCodexItemPrimaryIdentityKey(item: CodexItemPrimaryIdentityInput): string {
  return `${item.turnId}:id:${item.itemId}`;
}

export function isSyntheticCodexItemId(itemId: string): boolean {
  return /^item-\d+$/.test(itemId);
}

export function resolveCodexItemTextIdentityKey(item: CodexItemTextIdentityInput): string | null {
  const normalizedKind = item.normalizedKind;
  if (!isTextIdentityKind(normalizedKind)) {
    return null;
  }

  const normalizedText = normalizeUserMessageText(item.markdownText ?? "");
  if (!normalizedText) {
    return null;
  }

  return `${item.turnId}:text:${normalizedKind}:${normalizedText}`;
}

export function canMergeSyntheticTextDuplicate(
  existing: CodexItemTextIdentityInput,
  incoming: CodexItemTextIdentityInput,
): boolean {
  const samePrimary = resolveCodexItemPrimaryIdentityKey(existing) === resolveCodexItemPrimaryIdentityKey(incoming);
  if (samePrimary) return true;

  const oneSynthetic = isSyntheticCodexItemId(existing.itemId) !== isSyntheticCodexItemId(incoming.itemId);
  if (!oneSynthetic) return false;

  const existingTextKey = resolveCodexItemTextIdentityKey(existing);
  const incomingTextKey = resolveCodexItemTextIdentityKey(incoming);
  if (!existingTextKey || !incomingTextKey) return false;
  return existingTextKey === incomingTextKey;
}

export function mergeCodexItemView(existing: CodexItemView, incoming: CodexItemView): CodexItemView {
  return {
    ...existing,
    ...incoming,
    normalizedKind: incoming.normalizedKind,
    role: incoming.role ?? existing.role,
    toolCall: incoming.toolCall ?? existing.toolCall,
    markdownText: incoming.markdownText ?? existing.markdownText,
    userInputQuestions: incoming.userInputQuestions ?? existing.userInputQuestions,
    userInputAnswers: incoming.userInputAnswers ?? existing.userInputAnswers,
    rawItem: incoming.rawItem ?? existing.rawItem,
    status: incoming.status ?? existing.status,
    createdAt: Math.min(existing.createdAt, incoming.createdAt),
    updatedAt: Math.max(existing.updatedAt, incoming.updatedAt),
  };
}
