import type { DatabasePromotionSlot } from "./database-promotion-presentation";

/** Display-only insertion keeps pending identities outside Page indexes and selection. */
export const insertDatabasePromotionSlots = <Row>(
  rows: readonly Row[],
  slots: readonly DatabasePromotionSlot[],
  indexFor: (slot: DatabasePromotionSlot) => number,
): readonly (Row | DatabasePromotionSlot)[] => {
  const positions = new Map<number, DatabasePromotionSlot[]>();
  for (const slot of slots) {
    const index = Math.max(0, Math.min(rows.length, indexFor(slot)));
    positions.set(index, [...(positions.get(index) ?? []), slot]);
  }
  return rows
    .flatMap((row, index): (Row | DatabasePromotionSlot)[] => [
      ...(positions.get(index) ?? []),
      row,
    ])
    .concat(positions.get(rows.length) ?? []);
};
