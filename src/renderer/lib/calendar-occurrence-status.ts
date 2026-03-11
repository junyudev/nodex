import { ARCHIVED_CARD_OPTION_ID } from "./kanban-options";
import type { CalendarOccurrence, CardStatus } from "./types";

export function resolveOccurrenceMutationStatus(
  columnId: string,
  occurrence?: Pick<CalendarOccurrence, "status"> | null,
): CardStatus {
  if (columnId === ARCHIVED_CARD_OPTION_ID) {
    return occurrence?.status ?? "done";
  }
  return columnId as CardStatus;
}
