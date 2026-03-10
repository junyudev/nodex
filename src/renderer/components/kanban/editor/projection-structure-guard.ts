import {
  PROJECTION_OWNER_PROP,
  isProjectedCardToggleBlock,
} from "./projection-card-toggle";

type StructuralChangeType = "insert" | "delete" | "move" | "update";

interface StructureGuardBlockLike {
  id?: string;
  type?: string;
  props?: Record<string, unknown>;
}

export interface StructureGuardChange {
  type: StructuralChangeType;
  block: StructureGuardBlockLike;
  prevBlock?: StructureGuardBlockLike;
}

function isProjectionOwnerBlock(block: StructureGuardBlockLike | undefined): boolean {
  if (!block) return false;
  return block.type === "cardRef" || block.type === "toggleListInlineView";
}

function resolveProjectionOwnerId(block: StructureGuardBlockLike | undefined): string | null {
  if (!block || typeof block.props !== "object" || block.props === null) return null;
  const owner = block.props[PROJECTION_OWNER_PROP];
  return typeof owner === "string" && owner.length > 0 ? owner : null;
}

function collectDeletedProjectionOwnerIds(changes: StructureGuardChange[]): Set<string> {
  const ownerIds = new Set<string>();

  for (const change of changes) {
    if (change.type !== "delete") continue;
    if (!isProjectionOwnerBlock(change.block)) continue;
    if (typeof change.block.id !== "string" || change.block.id.length === 0) continue;
    ownerIds.add(change.block.id);
  }

  return ownerIds;
}

export function shouldRejectProjectedOwnerStructureChange(
  changes: StructureGuardChange[],
): boolean {
  const deletedProjectionOwnerIds = collectDeletedProjectionOwnerIds(changes);

  for (const change of changes) {
    const nextProjected = isProjectedCardToggleBlock(change.block);
    const prevProjected = isProjectedCardToggleBlock(change.prevBlock);

    if (change.type === "update" && nextProjected !== prevProjected) {
      return true;
    }

    if (
      change.type !== "insert"
      && change.type !== "delete"
      && change.type !== "move"
    ) {
      continue;
    }

    if (!nextProjected && !prevProjected) continue;

    if (change.type === "delete") {
      const ownerId = resolveProjectionOwnerId(change.block)
        ?? resolveProjectionOwnerId(change.prevBlock);
      if (ownerId && deletedProjectionOwnerIds.has(ownerId)) {
        continue;
      }
    }

    return true;
  }

  return false;
}

function isSourceCardToggleBlock(block: StructureGuardBlockLike | undefined): boolean {
  if (!block || block.type !== "cardToggle") return false;
  return !isProjectedCardToggleBlock(block);
}

export function shouldRejectToggleListStructureChange(
  changes: StructureGuardChange[],
): boolean {
  for (const change of changes) {
    const nextSourceCardToggle = isSourceCardToggleBlock(change.block);
    const prevSourceCardToggle = isSourceCardToggleBlock(change.prevBlock);

    if (
      (change.type === "insert" || change.type === "delete" || change.type === "move")
      && (nextSourceCardToggle || prevSourceCardToggle)
    ) {
      return true;
    }

    if (
      change.type === "update"
      && (change.block.type === "cardToggle" || change.prevBlock?.type === "cardToggle")
      && (nextSourceCardToggle !== prevSourceCardToggle)
    ) {
      return true;
    }
  }

  return false;
}
