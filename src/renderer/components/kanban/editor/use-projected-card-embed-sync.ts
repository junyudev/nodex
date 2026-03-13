import { useEffect, useMemo } from "react";
import type { CardInput, MoveCardInput } from "../../../lib/types";
import type {
  ToggleListCard,
  ToggleListPropertyKey,
} from "../../../lib/toggle-list/types";
import {
  buildProjectedCardToggleBlock,
  isProjectedCardMoveDirty,
  pickProjectedCardFieldUpdates,
  type ProjectionKind,
  type ProjectedCardPatch,
  serializeProjectionRows,
} from "./projection-card-toggle";
import {
  removeProjectionSyncOwner,
  upsertProjectionSyncOwner,
} from "./projection-sync-controller";

interface ProjectionRuntimeBlock {
  id?: string;
  type?: string;
  props?: Record<string, unknown>;
  children?: unknown[];
}

interface ProjectionCursorPosition {
  block?: {
    id?: string;
  };
}

interface ProjectionRuntimeEditor {
  getBlock: (id: string) => ProjectionRuntimeBlock | undefined;
  getParentBlock?: (id: string) => ProjectionRuntimeBlock | undefined;
  getTextCursorPosition?: () => ProjectionCursorPosition | undefined;
  updateBlock: (id: string, update: { children: unknown[] }) => void;
  onChange: (listener: () => void) => () => void;
  onSelectionChange?: (listener: () => void) => () => void;
}

interface UseProjectedCardEmbedSyncOptions {
  ownerBlockId: string;
  projectionKind: ProjectionKind;
  sourceProjectId: string;
  cards: ToggleListCard[];
  propertyOrder: ToggleListPropertyKey[];
  hiddenProperties: ToggleListPropertyKey[];
  showEmptyEstimate?: boolean;
  showEmptyPriority?: boolean;
  editor: unknown;
  enabled?: boolean;
  updateCard: (
    columnId: string,
    cardId: string,
    updates: Partial<CardInput>,
  ) => Promise<unknown>;
  patchCard: (
    columnId: string,
    cardId: string,
    updates: Partial<CardInput>,
  ) => void;
  moveCard: (input: MoveCardInput) => Promise<boolean>;
}

function supportsProjectionRuntimeEditor(value: unknown): value is ProjectionRuntimeEditor {
  if (typeof value !== "object" || value === null) return false;
  const runtime = value as Partial<ProjectionRuntimeEditor>;
  if (typeof runtime.getBlock !== "function") return false;
  if (typeof runtime.updateBlock !== "function") return false;
  return typeof runtime.onChange === "function";
}

export function isProjectedPatchDirty(
  patch: ProjectedCardPatch,
  card: Pick<ToggleListCard, "title" | "description" | "priority" | "estimate" | "tags" | "columnId">,
): boolean {
  if (Object.keys(pickProjectedCardFieldUpdates(patch, card)).length > 0) {
    return true;
  }

  return isProjectedCardMoveDirty(patch, card);
}

export function mergeProjectedPatchesIntoPending(
  pendingPatches: Map<string, ProjectedCardPatch>,
  nextPatches: ProjectedCardPatch[],
  cardById: ReadonlyMap<string, Pick<
  ToggleListCard,
    "id" | "title" | "description" | "priority" | "estimate" | "tags" | "columnId"
>>,
): void {
  for (const patch of nextPatches) {
    const card = cardById.get(patch.cardId);
    if (!card) {
      pendingPatches.delete(patch.cardId);
      continue;
    }

    if (!isProjectedPatchDirty(patch, card)) {
      pendingPatches.delete(patch.cardId);
      continue;
    }

    pendingPatches.set(patch.cardId, patch);
  }
}

export function getReadyProjectedPatches(
  pendingPatches: ReadonlyMap<string, ProjectedCardPatch>,
  inFlightCardIds: ReadonlySet<string>,
): ProjectedCardPatch[] {
  const ready: ProjectedCardPatch[] = [];

  for (const [cardId, patch] of pendingPatches) {
    if (inFlightCardIds.has(cardId)) continue;
    ready.push(patch);
  }

  return ready;
}

export function isBlockWithinOwnerTree(
  getParentBlock: (id: string) => ProjectionRuntimeBlock | undefined,
  ownerBlockId: string,
  startBlockId: string,
): boolean {
  if (startBlockId.length === 0) return false;

  const visited = new Set<string>();
  let currentId: string | undefined = startBlockId;

  while (typeof currentId === "string" && currentId.length > 0) {
    if (currentId === ownerBlockId) return true;
    if (visited.has(currentId)) return false;
    visited.add(currentId);

    const parent = getParentBlock(currentId);
    currentId = typeof parent?.id === "string" ? parent.id : undefined;
  }

  return false;
}

export function isCursorWithinOwnerTree(
  editor: Pick<Required<ProjectionRuntimeEditor>, "getParentBlock" | "getTextCursorPosition">,
  ownerBlockId: string,
): boolean {
  const cursor = editor.getTextCursorPosition();
  const cursorBlockId = cursor?.block?.id;
  if (typeof cursorBlockId !== "string" || cursorBlockId.length === 0) {
    return false;
  }

  return isBlockWithinOwnerTree(
    (blockId) => editor.getParentBlock(blockId),
    ownerBlockId,
    cursorBlockId,
  );
}

export function useProjectedCardEmbedSync({
  ownerBlockId,
  projectionKind,
  sourceProjectId,
  cards,
  propertyOrder,
  hiddenProperties,
  showEmptyEstimate = false,
  showEmptyPriority = false,
  editor,
  enabled = true,
  updateCard,
  patchCard,
  moveCard,
}: UseProjectedCardEmbedSyncOptions): void {
  const cardById = useMemo(
    () => new Map(cards.map((card) => [card.id, card])),
    [cards],
  );

  const projectedRows = useMemo(
    () => cards.map((card) => buildProjectedCardToggleBlock({
      ownerBlockId,
      projectionKind,
      sourceProjectId,
      card,
      propertyOrder,
      hiddenProperties,
      showEmptyEstimate,
      showEmptyPriority,
    })),
    [
      cards,
      hiddenProperties,
      ownerBlockId,
      projectionKind,
      propertyOrder,
      showEmptyEstimate,
      showEmptyPriority,
      sourceProjectId,
    ],
  );

  const projectedRowsSignature = useMemo(
    () => serializeProjectionRows(projectedRows),
    [projectedRows],
  );

  useEffect(() => {
    if (!supportsProjectionRuntimeEditor(editor)) return;

    upsertProjectionSyncOwner(editor, {
      ownerBlockId,
      enabled,
      projectedRows,
      projectedRowsSignature,
      cardById,
      updateCard,
      patchCard,
      moveCard,
    });
  }, [
    cardById,
    editor,
    enabled,
    moveCard,
    patchCard,
    ownerBlockId,
    projectedRows,
    projectedRowsSignature,
    updateCard,
  ]);

  useEffect(() => {
    if (!supportsProjectionRuntimeEditor(editor)) return;

    return () => {
      removeProjectionSyncOwner(editor, ownerBlockId);
    };
  }, [editor, ownerBlockId]);
}
