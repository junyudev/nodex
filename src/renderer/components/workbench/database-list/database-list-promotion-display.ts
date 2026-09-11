import type { DatabasePromotionSlot } from "@/lib/database-promotion-presentation";
import { insertDatabasePromotionSlots } from "@/lib/database-promotion-display";
import type { DatabaseListProjectionRow } from "./database-list-model";

export type DatabaseListPromotionDisplayRow =
  | DatabaseListProjectionRow
  | (DatabasePromotionSlot & { readonly height: number });

export const databaseListPromotionDisplay = (
  rows: readonly DatabaseListProjectionRow[],
  slots: readonly DatabasePromotionSlot[],
): readonly DatabaseListPromotionDisplayRow[] =>
  insertDatabasePromotionSlots(rows, slots, (slot) => {
    if (slot.placement.kind !== "list_occurrence" || slot.placement.target.kind === "root")
      return rows.length;
    const target = slot.placement.target;
    const index = rows.findIndex((row) => row.key === target.occurrenceKey);
    if (index < 0) return rows.length;
    if (target.kind === "group" || target.edge === "inside") return index + 1;
    if (target.edge === "before") return index;
    const parent = rows[index];
    if (parent?.kind !== "page") return index + 1;
    const after = rows.findIndex(
      (row, candidate) =>
        candidate > index && (row.kind !== "page" || !row.ancestorPageIds.includes(parent.pageId)),
    );
    return after < 0 ? rows.length : after;
  }).map((row) => (row.kind === "pending_promotion" ? { ...row, height: 32 } : row));
