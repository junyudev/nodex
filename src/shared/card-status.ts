export const CARD_STATUS_ORDER = [
  "draft",
  "backlog",
  "in_progress",
  "in_review",
  "done",
] as const;

export type CardStatus = (typeof CARD_STATUS_ORDER)[number];

export const CARD_STATUS_LABELS: Record<CardStatus, string> = {
  draft: "Draft",
  backlog: "Backlog",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
};

export const DEFAULT_CARD_STATUS: CardStatus = "draft";

export const CARD_STATUS_COLUMNS = CARD_STATUS_ORDER.map((status) => ({
  id: status,
  name: CARD_STATUS_LABELS[status],
}));

export function isCardStatus(value: unknown): value is CardStatus {
  return typeof value === "string" && CARD_STATUS_ORDER.includes(value as CardStatus);
}

export function getCardStatusLabel(status: CardStatus): string {
  return CARD_STATUS_LABELS[status];
}

export function compareCardStatuses(left: CardStatus, right: CardStatus): number {
  return CARD_STATUS_ORDER.indexOf(left) - CARD_STATUS_ORDER.indexOf(right);
}
