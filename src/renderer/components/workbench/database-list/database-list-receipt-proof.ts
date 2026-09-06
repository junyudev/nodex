import type { DatabaseViewMutationReceipt } from "@/lib/database-view-row-mutations";
import type { DatabaseListProjectionRowSnapshot } from "../../../../shared/database-views";

/**
 * Exact position and value resource revisions survive subsequent neighborhood
 * edits. A raw occurrence carrying every receipt revision proves the committed
 * move was incorporated even when a later actor changed its adjacent sibling.
 */
export const databaseListRowsCoverMoveReceipt = (input: {
  readonly viewId: string;
  readonly rows: readonly DatabaseListProjectionRowSnapshot[];
  readonly receipt: DatabaseViewMutationReceipt;
}): boolean => {
  const { receipt } = input;
  if (receipt.operationKinds.length !== 1 || receipt.operationKinds[0] !== "move_list_occurrences")
    return false;
  const outcome = receipt.operationOutcomes[0];
  if (
    receipt.operationOutcomes.length !== 1 ||
    outcome?.kind !== "list_occurrence_move" ||
    outcome.operationIndex !== 0
  )
    return false;
  const { viewId, dataSourceId } = outcome.undoRecipe;
  if (input.viewId !== viewId) return false;
  const rows = input.rows.flatMap((snapshot) =>
    snapshot.kind === "page" &&
    snapshot.transientKind === "none" &&
    snapshot.row.membership.dataSourceId === dataSourceId
      ? [snapshot.row]
      : [],
  );
  if (
    outcome.moveRootPageIds.length === 0 ||
    outcome.moveRootPageIds.some((pageId) => !rows.some((row) => row.page.pageId === pageId))
  )
    return false;
  const semanticRevisions = Object.entries(receipt.committedRevisions).filter(
    ([key]) => key.startsWith("position:") || key.startsWith("value:"),
  );
  if (semanticRevisions.length === 0) return false;
  const observed = new Map<string, number>();
  for (const row of rows) {
    if (row.position) observed.set(`position:${viewId}:${row.page.pageId}`, row.position.revision);
    for (const [propertyId, value] of Object.entries(row.values)) {
      observed.set(
        `value:${dataSourceId}:${row.membership.membershipId}:${propertyId}`,
        value.revision,
      );
    }
  }
  return semanticRevisions.every(([key, revision]) => {
    const current = observed.get(key);
    return current !== undefined && current >= revision;
  });
};
