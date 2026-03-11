import type {
  BlockDropImportSourceUpdate,
  CardStatus,
  CardDropMoveToEditorInput,
} from "@/lib/types";
import { resolveCardDropTargetAtPointer } from "./editor/card-drop-target-registry";
import type { ExternalCardDragSession } from "./editor/external-card-drag-session";

export function resolveExternalCardDropTarget(
  isSearchActive: boolean,
  session: ExternalCardDragSession | null,
) {
  if (isSearchActive) return null;
  if (!session?.pointer) return null;
  return resolveCardDropTargetAtPointer(session.pointer, session.payload);
}

export interface ExternalCardDropMoveRequest {
  targetProjectId: string;
  input: CardDropMoveToEditorInput;
}

interface BuildExternalCardDropMoveRequestInput {
  sourceProjectId: string;
  sourceCards: Array<{
    cardId: string;
    status: CardStatus;
  }>;
  groupId: string;
  targetUpdates: BlockDropImportSourceUpdate[];
}

export function buildExternalCardDropMoveRequest({
  sourceProjectId,
  sourceCards,
  groupId,
  targetUpdates,
}: BuildExternalCardDropMoveRequestInput): ExternalCardDropMoveRequest | null {
  if (sourceCards.length === 0) return null;
  if (targetUpdates.length === 0) return null;

  const targetProjectId = targetUpdates[0]?.projectId;
  if (!targetProjectId) return null;
  if (targetUpdates.some((update) => update.projectId !== targetProjectId)) {
    return null;
  }

  const [primarySource] = sourceCards;
  if (!primarySource) return null;

  return {
    targetProjectId,
    input: {
      sourceCardId: primarySource.cardId,
      sourceStatus: primarySource.status,
      sourceCards: sourceCards.map((source) => ({
        cardId: source.cardId,
        status: source.status,
      })),
      targetUpdates,
      groupId,
      ...(sourceProjectId !== targetProjectId ? { sourceProjectId } : {}),
    },
  };
}
