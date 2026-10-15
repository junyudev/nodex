import type { DatabaseListMoveTargetV2 } from "../../../../shared/database-module-v2";
import type { DatabaseListProjectionRow } from "./database-list-model";

export type DatabaseListBlockDropFeedback =
  | {
      readonly kind: "line";
      readonly occurrenceKey: string;
      readonly edge: "before" | "after";
    }
  | {
      readonly kind: "surface";
      readonly occurrenceKey: string | null;
    };

export interface DatabaseListBlockDropPreview {
  readonly target: DatabaseListMoveTargetV2;
  readonly feedback: DatabaseListBlockDropFeedback;
  readonly message: string | null;
}

export const resolveDatabaseListBlockDropRejection = (input: {
  readonly pageDragActive: boolean;
  readonly searchActive: boolean;
  readonly projectionReady: boolean;
}): string | null => {
  if (input.pageDragActive) return "Finish moving Pages before importing Blocks";
  if (input.searchActive) return "Clear search to add Blocks as Pages";
  if (!input.projectionReady) return "Wait for the List to finish loading";
  return null;
};

const groupTargetFor = (
  rows: readonly DatabaseListProjectionRow[],
  row: DatabaseListProjectionRow,
): DatabaseListMoveTargetV2 => {
  if (row.kind === "group" || row.kind === "subgroup") {
    return { kind: "group", occurrenceKey: row.key };
  }
  const subgroup = rows.find(
    (candidate) =>
      candidate.kind === "subgroup" &&
      candidate.groupKey === row.groupKey &&
      candidate.subgroupKey === row.subgroupKey,
  );
  if (subgroup) return { kind: "group", occurrenceKey: subgroup.key };
  const group = rows.find(
    (candidate) => candidate.kind === "group" && candidate.groupKey === row.groupKey,
  );
  return group ? { kind: "group", occurrenceKey: group.key } : { kind: "root" };
};

/**
 * External Blocks only author root-level List placement. Nested rows collapse
 * to their owning group until List exposes a dedicated nesting affordance.
 */
export const resolveDatabaseListBlockDropPreview = (input: {
  readonly rows: readonly DatabaseListProjectionRow[];
  readonly overOccurrenceKey: string | null;
  readonly pointerY: number;
  readonly rowTop: number;
  readonly rowBottom: number;
  readonly exactSlot: boolean;
}): DatabaseListBlockDropPreview | null => {
  if (input.overOccurrenceKey === null) {
    return {
      target: { kind: "root" },
      feedback: { kind: "surface", occurrenceKey: null },
      message: input.exactSlot ? null : "Current sort decides the Page position",
    };
  }
  const rowIndex = input.rows.findIndex((row) => row.key === input.overOccurrenceKey);
  const row = input.rows[rowIndex];
  if (!row) return null;
  const groupTarget = groupTargetFor(input.rows, row);
  if (row.kind !== "page") {
    return {
      target: groupTarget,
      feedback: { kind: "surface", occurrenceKey: row.key },
      message: input.exactSlot ? null : "Current sort decides the Page position",
    };
  }
  if (!input.exactSlot || row.depth > 0 || row.transientKind !== "none") {
    return {
      target: groupTarget,
      feedback: {
        kind: "surface",
        occurrenceKey: groupTarget.kind === "group" ? groupTarget.occurrenceKey : null,
      },
      message: !input.exactSlot ? "Current sort decides the Page position" : "Drop into this group",
    };
  }
  const midpoint = input.rowTop + (input.rowBottom - input.rowTop) / 2;
  if (input.pointerY < midpoint) {
    return {
      target: { kind: "page", occurrenceKey: row.key, edge: "before" },
      feedback: { kind: "line", occurrenceKey: row.key, edge: "before" },
      message: null,
    };
  }
  const nextRootIndex = rowIndex + Math.max(1, row.subtreeOccurrenceCount);
  const nextRoot = input.rows[nextRootIndex];
  if (
    nextRoot?.kind === "page" &&
    nextRoot.depth === 0 &&
    nextRoot.transientKind === "none" &&
    nextRoot.groupKey === row.groupKey &&
    nextRoot.subgroupKey === row.subgroupKey
  ) {
    return {
      target: { kind: "page", occurrenceKey: nextRoot.key, edge: "before" },
      feedback: { kind: "line", occurrenceKey: nextRoot.key, edge: "before" },
      message: null,
    };
  }
  return {
    target: groupTarget,
    feedback: { kind: "line", occurrenceKey: row.key, edge: "after" },
    message: null,
  };
};
