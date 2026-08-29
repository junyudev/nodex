import type { LibraryPageFileOwnershipMove } from "../../shared/library-module";

export interface PageFileOwnershipMoveCollisionFeedback {
  readonly title: string;
  readonly description: string;
}

const SUMMARY_PATH_LIMIT = 3;

/** Summarizes only collision-driven path changes from an originating command receipt. */
export function summarizePageFileOwnershipMoveCollisions(
  moves: readonly LibraryPageFileOwnershipMove[],
): PageFileOwnershipMoveCollisionFeedback | null {
  const renamed = moves.filter((move) => move.previousLogicalPath !== move.logicalPath);
  const first = renamed[0];
  if (!first) return null;

  if (renamed.length === 1) {
    return {
      title: `Moved as ${first.logicalPath}`,
      description: `The destination already had ${first.previousLogicalPath}.`,
    };
  }

  const visiblePaths = renamed.slice(0, SUMMARY_PATH_LIMIT).map((move) => move.logicalPath);
  const hiddenCount = renamed.length - visiblePaths.length;
  return {
    title: `${renamed.length} files renamed while moving`,
    description: [...visiblePaths, ...(hiddenCount > 0 ? [`+${hiddenCount} more`] : [])].join(
      " · ",
    ),
  };
}
