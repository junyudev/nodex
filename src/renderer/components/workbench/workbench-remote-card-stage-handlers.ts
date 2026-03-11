import { invoke } from "@/lib/api";
import type { CardInput, CardUpdateMutationResult, CardUpdateResult } from "@/lib/types";
import type { CardStageHandlers } from "@/lib/use-card-stage";

export function makeRemoteCardStageHandlers(projectId: string): CardStageHandlers {
  return {
    onPatch: () => {
      // no-op for remote-opened sessions
    },
    onUpdate: async (columnId: string, cardId: string, updates: Partial<CardInput>) => {
      const result = await invoke("card:update", projectId, columnId, cardId, updates) as CardUpdateResult;
      return result as CardUpdateMutationResult;
    },
    onDelete: async (columnId: string, cardId: string) => {
      await invoke("card:delete", projectId, columnId, cardId);
    },
    onMove: async (fromStatus: string, cardId: string, toStatus: string) => {
      await invoke("card:move", {
        projectId,
        cardId,
        fromStatus,
        toStatus,
      });
    },
    onCompleteOccurrence: async (cardId: string, occurrenceStart: Date) => {
      await invoke("card:occurrence:complete", projectId, { cardId, occurrenceStart });
    },
    onSkipOccurrence: async (cardId: string, occurrenceStart: Date) => {
      await invoke("card:occurrence:skip", projectId, { cardId, occurrenceStart });
    },
  };
}
