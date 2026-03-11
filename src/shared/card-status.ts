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

export const LEGACY_ARCHIVE_COLUMN_ID = "n-archive";

export const LEGACY_CARD_COLUMN_ORDER = [
  "1-ideas",
  "2-analyzing",
  "3-backlog",
  "4-planning",
  "5-ready",
  "6-in-progress",
  "7-review",
  "8-done",
  LEGACY_ARCHIVE_COLUMN_ID,
] as const;

export type LegacyCardColumnId = (typeof LEGACY_CARD_COLUMN_ORDER)[number];

export const LEGACY_CARD_COLUMN_LABELS: Record<LegacyCardColumnId, string> = {
  "1-ideas": "Ideas",
  "2-analyzing": "Analyzing",
  "3-backlog": "Backlog",
  "4-planning": "Planning",
  "5-ready": "Ready",
  "6-in-progress": "In Progress",
  "7-review": "Review",
  "8-done": "Done",
  [LEGACY_ARCHIVE_COLUMN_ID]: "Archive",
};

export const CARD_STATUS_COLUMNS = CARD_STATUS_ORDER.map((status) => ({
  id: status,
  name: CARD_STATUS_LABELS[status],
}));

const LEGACY_COLUMN_TO_CARD_STATE: Record<LegacyCardColumnId, { status: CardStatus; archived: boolean }> = {
  "1-ideas": { status: "draft", archived: false },
  "2-analyzing": { status: "draft", archived: false },
  "3-backlog": { status: "backlog", archived: false },
  "4-planning": { status: "draft", archived: false },
  "5-ready": { status: "backlog", archived: false },
  "6-in-progress": { status: "in_progress", archived: false },
  "7-review": { status: "in_review", archived: false },
  "8-done": { status: "done", archived: false },
  [LEGACY_ARCHIVE_COLUMN_ID]: { status: "done", archived: true },
};

export function isCardStatus(value: unknown): value is CardStatus {
  return typeof value === "string" && CARD_STATUS_ORDER.includes(value as CardStatus);
}

export function isLegacyCardColumnId(value: unknown): value is LegacyCardColumnId {
  return typeof value === "string" && LEGACY_CARD_COLUMN_ORDER.includes(value as LegacyCardColumnId);
}

export function getCardStatusLabel(status: CardStatus): string {
  return CARD_STATUS_LABELS[status];
}

export function compareCardStatuses(left: CardStatus, right: CardStatus): number {
  return CARD_STATUS_ORDER.indexOf(left) - CARD_STATUS_ORDER.indexOf(right);
}

export function mapLegacyColumnIdToCardState(
  legacyColumnId: string,
): { status: CardStatus; archived: boolean } | null {
  if (!isLegacyCardColumnId(legacyColumnId)) return null;
  return LEGACY_COLUMN_TO_CARD_STATE[legacyColumnId];
}
