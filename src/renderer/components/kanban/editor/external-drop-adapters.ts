import { applyToggleStatesFromDom, blockNoteToNfm, serializeNfm } from "@/lib/nfm";
import { blockToCardPatch } from "@/lib/toggle-list/block-mapping";
import type { ToggleListCard } from "@/lib/toggle-list/types";
import type {
  BlockDropImportSourceUpdate,
  CardInput,
} from "@/lib/types";
import type {
  DragSessionBlock,
  EditorForExternalBlockDrop,
  ExternalDropAdapter,
} from "./external-block-drag-session";
import { stripProjectedSubtrees } from "./projection-card-toggle";

interface CardStageSourceContext {
  projectId: string;
  columnId: string;
  cardId: string;
}

function serializeEditorDocument(
  editor: EditorForExternalBlockDrop,
  container: HTMLElement,
): string {
  const strippedDocument = stripProjectedSubtrees(editor.document);
  const nfmBlocks = blockNoteToNfm(strippedDocument);
  applyToggleStatesFromDom(strippedDocument, nfmBlocks, container);
  return serializeNfm(nfmBlocks);
}

interface TogglePatch {
  cardId: string;
  description: string;
}

function collectToggleCardPatches(
  blocks: DragSessionBlock[],
  container: HTMLElement,
): Map<string, TogglePatch> {
  const patches = new Map<string, TogglePatch>();

  for (const block of blocks) {
    const patch = blockToCardPatch(block, container);
    if (!patch) continue;
    patches.set(patch.cardId, {
      cardId: patch.cardId,
      description: patch.description,
    });
  }

  return patches;
}

function toDescriptionUpdate(description: string): Partial<CardInput> {
  return { description };
}

export function createCardStageDropAdapter(
  context: CardStageSourceContext,
  beginOptimisticMutation: (() => () => void) | undefined,
): ExternalDropAdapter {
  return {
    captureBaseline(editor, container) {
      return serializeEditorDocument(editor, container);
    },
    buildSourceUpdates(editor, container, baseline) {
      if (typeof baseline !== "string") return [];
      const nextDescription = serializeEditorDocument(editor, container);
      if (nextDescription === baseline) return [];

      return [
        {
          projectId: context.projectId,
          columnId: context.columnId,
          cardId: context.cardId,
          updates: toDescriptionUpdate(nextDescription),
        },
      ];
    },
    beginOptimisticMutation,
  };
}

export function createToggleListDropAdapter(
  projectId: string,
  cards: ToggleListCard[],
  beginOptimisticMutation: (() => () => void) | undefined,
): ExternalDropAdapter {
  const cardIds = new Set(cards.map((card) => card.id));

  return {
    captureBaseline(editor, container) {
      return collectToggleCardPatches(editor.document, container);
    },
    buildSourceUpdates(editor, container, baseline) {
      if (!(baseline instanceof Map)) return [];
      const nextPatches = collectToggleCardPatches(editor.document, container);
      const updates: BlockDropImportSourceUpdate[] = [];

      for (const [cardId, nextPatch] of nextPatches) {
        if (!cardIds.has(cardId)) continue;

        const previousPatch = baseline.get(cardId);
        if (previousPatch?.description === nextPatch.description) continue;

        updates.push({
          projectId,
          cardId,
          updates: toDescriptionUpdate(nextPatch.description),
        });
      }

      return updates;
    },
    beginOptimisticMutation,
  };
}
