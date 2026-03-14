import type { CardInput } from "@/lib/types";

const LOCAL_ONLY_DRAFT_KEYS = new Set<keyof CardInput>([
  "title",
  "description",
  "assignee",
  "agentStatus",
]);

export function shouldPublishCardStagePatch(updates: Partial<CardInput>): boolean {
  const keys = Object.keys(updates) as Array<keyof CardInput>;
  if (keys.length === 0) return false;

  return keys.some((key) => !LOCAL_ONLY_DRAFT_KEYS.has(key));
}
