import type { Card, CardInput } from "@/lib/types";

export interface CardStageTextDraftState {
  title: string;
  description: string;
  assignee: string;
  agentStatus: string;
}

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

export function buildCardStageDraftOverlay(
  card: Pick<Card, "title" | "description" | "assignee" | "agentStatus">,
  draft: CardStageTextDraftState,
): Pick<Partial<CardInput>, "title" | "description" | "assignee" | "agentStatus"> {
  const overlay: Pick<Partial<CardInput>, "title" | "description" | "assignee" | "agentStatus"> = {};

  if (draft.title !== card.title) {
    overlay.title = draft.title;
  }
  if (draft.description !== (card.description ?? "")) {
    overlay.description = draft.description;
  }
  if (draft.assignee !== (card.assignee ?? "")) {
    overlay.assignee = draft.assignee;
  }
  if (draft.agentStatus !== (card.agentStatus ?? "")) {
    overlay.agentStatus = draft.agentStatus;
  }

  return overlay;
}
