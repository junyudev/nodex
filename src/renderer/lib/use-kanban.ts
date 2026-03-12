import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  buildCompleteOrSkipOccurrenceTransform,
  buildCreateCardTransform,
  buildDeleteCardTransform,
  buildImportBlockDropTransform,
  buildMoveCardTransform,
  buildMoveCardsTransform,
  buildMoveDropToEditorTransform,
  buildPatchCardTransform,
  conflictKeyForCard,
  conflictKeysForCreate,
  conflictKeysForDelete,
  conflictKeysForMove,
  conflictKeysForMoveMany,
  conflictKeysForPatch,
  createOptimisticCard,
} from "./kanban-optimistic-ops";
import { createUuidV7 } from "../../shared/card-id";
import type {
  BlockDropImportInput,
  BlockDropImportResult,
  CalendarOccurrence,
  CardDropMoveToEditorInput,
  CardDropMoveToEditorResult,
  Card,
  CardCreateInput,
  CardCreatePlacement,
  CardInput,
  CardUpdateMutationResult,
  CardUpdateResult,
  CardOccurrenceActionInput,
  CardOccurrenceUpdateInput,
  MoveCardInput,
  MoveCardToProjectInput,
  MoveCardToProjectResult,
  MoveCardsInput,
} from "./types";
import { invoke } from "./api";
import { getKanbanProjectStore } from "./kanban-store";

interface UseKanbanOptions {
  projectId: string;
  sessionId?: string;
  onMutation?: () => void;
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toErrorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  return "Unknown error";
}

function ensureCreateInputId(input: CardCreateInput): CardCreateInput {
  if (input.id && input.id.trim().length > 0) return input;
  return {
    ...input,
    id: createUuidV7(),
  };
}

function normalizeOccurrenceUpdatesToCardPatch(
  input: CardOccurrenceUpdateInput,
): Partial<CardInput> {
  const patch: Partial<CardInput> = {};
  if (Object.prototype.hasOwnProperty.call(input.updates, "scheduledStart")) patch.scheduledStart = input.updates.scheduledStart;
  if (Object.prototype.hasOwnProperty.call(input.updates, "scheduledEnd")) patch.scheduledEnd = input.updates.scheduledEnd;
  if (Object.prototype.hasOwnProperty.call(input.updates, "isAllDay")) patch.isAllDay = input.updates.isAllDay;
  if (Object.prototype.hasOwnProperty.call(input.updates, "recurrence")) patch.recurrence = input.updates.recurrence;
  if (Object.prototype.hasOwnProperty.call(input.updates, "reminders")) patch.reminders = input.updates.reminders;
  if (Object.prototype.hasOwnProperty.call(input.updates, "scheduleTimezone")) patch.scheduleTimezone = input.updates.scheduleTimezone;
  return patch;
}

export function useKanban(options: UseKanbanOptions) {
  const { projectId, sessionId, onMutation } = options;
  const store = useMemo(
    () => getKanbanProjectStore(projectId),
    [projectId],
  );

  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
  );

  const fetchBoard = useCallback(async () => {
    await store.fetchBoard();
  }, [store]);

  const createCard = useCallback(
    async (
      columnId: string,
      input: CardCreateInput,
      placement: CardCreatePlacement = "bottom",
    ): Promise<Card | null> => {
      const createInput = ensureCreateInputId(input);
      const optimisticCard = createOptimisticCard(createInput);
      const outcome = await store.runOptimisticMutation<Card>({
        kind: "card:create",
        conflictKeys: conflictKeysForCreate(columnId, optimisticCard.id),
        apply: buildCreateCardTransform(columnId, optimisticCard, placement),
        runRemote: async () => (await invoke(
          "card:create",
          projectId,
          columnId,
          createInput,
          sessionId,
          placement,
        )) as Card,
      });

      if (!outcome.ok) return null;
      onMutation?.();
      return outcome.result ?? null;
    },
    [onMutation, projectId, sessionId, store],
  );

  const updateCard = useCallback(
    async (
      columnId: string,
      cardId: string,
      updates: Partial<CardInput>,
    ): Promise<CardUpdateMutationResult> => {
      const conflictKeys = conflictKeysForPatch(cardId, updates);
      const expectedRevision = store.getSnapshot().cardIndex.get(cardId)?.revision;
      const outcome = await store.runOptimisticMutation<CardUpdateResult>({
        kind: "card:update",
        conflictKeys,
        apply: buildPatchCardTransform(columnId, cardId, updates, { bumpRevision: true }),
        runRemote: async () => (
          (await invoke(
            "card:update",
            projectId,
            columnId,
            cardId,
            updates,
            sessionId,
            expectedRevision,
          )) as CardUpdateResult
        ),
      });

      if (!outcome.ok) {
        return {
          status: "error",
          error: outcome.error?.message ?? "Failed to update card",
        };
      }

      const result = outcome.result;
      if (!result) {
        return {
          status: "error",
          error: "Missing card update result",
        };
      }

      if (result.status === "updated") {
        onMutation?.();
        return result;
      }

      if (result.status === "conflict") {
        store.resolveConflict(conflictKeys);
        await store.refreshBoard();
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("nodex:card-update-conflict", {
            detail: {
              projectId,
              cardId,
            },
          }));
        }
        return result;
      }

      return result;
    },
    [onMutation, projectId, sessionId, store],
  );

  const getCard = useCallback(
    async (cardId: string, columnId?: string): Promise<Card | null> => {
      try {
        return (await invoke("card:get", projectId, cardId, columnId)) as Card | null;
      } catch (err) {
        store.setError(toErrorMessage(err));
        return null;
      }
    },
    [projectId, store],
  );

  const deleteCard = useCallback(
    async (columnId: string, cardId: string): Promise<boolean> => {
      const outcome = await store.runOptimisticMutation<boolean>({
        kind: "card:delete",
        conflictKeys: conflictKeysForDelete(cardId),
        apply: buildDeleteCardTransform(columnId, cardId),
        runRemote: async () => (await invoke(
          "card:delete",
          projectId,
          columnId,
          cardId,
          sessionId,
        )) as boolean,
      });
      if (!outcome.ok) return false;
      if (!outcome.result) {
        store.setError("Failed to delete card");
        return false;
      }
      onMutation?.();
      return true;
    },
    [onMutation, projectId, sessionId, store],
  );

  const moveCard = useCallback(
    async (input: MoveCardInput): Promise<boolean> => {
      const outcome = await store.runOptimisticMutation<boolean>({
        kind: "card:move",
        conflictKeys: conflictKeysForMove(input),
        apply: buildMoveCardTransform(input),
        runRemote: async () => (await invoke("card:move", {
          ...input,
          projectId,
          sessionId,
        })) as boolean,
      });
      if (!outcome.ok) return false;
      if (!outcome.result) {
        store.setError("Failed to move card");
        return false;
      }
      onMutation?.();
      return true;
    },
    [onMutation, projectId, sessionId, store],
  );

  const moveCards = useCallback(
    async (input: MoveCardsInput): Promise<boolean> => {
      const outcome = await store.runOptimisticMutation<boolean>({
        kind: "card:move-many",
        conflictKeys: conflictKeysForMoveMany(input),
        apply: buildMoveCardsTransform(input),
        runRemote: async () => (await invoke("card:move-many", {
          ...input,
          projectId,
          sessionId,
        })) as boolean,
      });
      if (!outcome.ok) return false;
      if (!outcome.result) {
        store.setError("Failed to move cards");
        return false;
      }
      onMutation?.();
      return true;
    },
    [onMutation, projectId, sessionId, store],
  );

  const moveCardToProject = useCallback(
    async (
      input: Omit<MoveCardToProjectInput, "sourceProjectId">,
    ): Promise<MoveCardToProjectResult | null> => {
      const outcome = await store.runOptimisticMutation<MoveCardToProjectResult>({
        kind: "card:move-to-project",
        conflictKeys: conflictKeysForDelete(input.cardId),
        apply: buildDeleteCardTransform(input.sourceStatus, input.cardId),
        runRemote: async () => (await invoke("card:move-to-project", {
          ...input,
          sourceProjectId: projectId,
          sessionId,
        })) as MoveCardToProjectResult,
      });

      if (!outcome.ok) return null;
      onMutation?.();
      return outcome.result ?? null;
    },
    [onMutation, projectId, sessionId, store],
  );

  const importBlockDrop = useCallback(
    async (input: BlockDropImportInput): Promise<BlockDropImportResult | null> => {
      const cardsWithId = input.cards.map((card) => ensureCreateInputId(card));
      const optimisticCards = cardsWithId.map((card) => createOptimisticCard(card));
      const optimisticInput: BlockDropImportInput = {
        ...input,
        cards: cardsWithId,
      };

      const outcome = await store.runOptimisticMutation<BlockDropImportResult>({
        kind: "card:import-block-drop",
        conflictKeys: [
          `column:${input.targetStatus}:cards`,
          ...input.sourceUpdates.map((update) => conflictKeyForCard(update.cardId)),
          ...optimisticCards.map((card) => conflictKeyForCard(card.id)),
        ],
        apply: buildImportBlockDropTransform(optimisticInput, optimisticCards),
        runRemote: async () => (await invoke(
          "card:import-block-drop",
          projectId,
          optimisticInput,
          sessionId,
        )) as BlockDropImportResult,
      });

      if (!outcome.ok) return null;
      onMutation?.();
      return outcome.result ?? null;
    },
    [onMutation, projectId, sessionId, store],
  );

  const moveCardDropToEditor = useCallback(
    async (
      input: CardDropMoveToEditorInput,
    ): Promise<CardDropMoveToEditorResult | null> => {
      const outcome = await store.runOptimisticMutation<CardDropMoveToEditorResult>({
        kind: "card:move-drop-to-editor",
        conflictKeys: [
          ...input.targetUpdates.map((update) => conflictKeyForCard(update.cardId)),
          ...(input.sourceCards?.map((entry) => conflictKeyForCard(entry.cardId)) ?? [conflictKeyForCard(input.sourceCardId)]),
        ],
        apply: buildMoveDropToEditorTransform(input),
        runRemote: async () => (await invoke(
          "card:move-drop-to-editor",
          projectId,
          input,
          sessionId,
        )) as CardDropMoveToEditorResult,
      });

      if (!outcome.ok) return null;
      onMutation?.();
      return outcome.result ?? null;
    },
    [onMutation, projectId, sessionId, store],
  );

  const listCalendarOccurrences = useCallback(
    async (
      windowStart: Date,
      windowEnd: Date,
      searchQuery?: string,
    ): Promise<CalendarOccurrence[]> => {
      try {
        const result = (await invoke(
          "calendar:occurrences",
          projectId,
          windowStart,
          windowEnd,
          searchQuery,
        )) as { occurrences: CalendarOccurrence[] };
        return result.occurrences.map((occurrence) => ({
          ...occurrence,
          created: asDate(occurrence.created),
          dueDate: occurrence.dueDate ? asDate(occurrence.dueDate) : undefined,
          scheduledStart: asDate(occurrence.scheduledStart ?? occurrence.occurrenceStart),
          scheduledEnd: asDate(occurrence.scheduledEnd ?? occurrence.occurrenceEnd),
          occurrenceStart: asDate(occurrence.occurrenceStart),
          occurrenceEnd: asDate(occurrence.occurrenceEnd),
        }));
      } catch (err) {
        store.setError(toErrorMessage(err));
        return [];
      }
    },
    [projectId, store],
  );

  const completeOccurrence = useCallback(
    async (input: CardOccurrenceActionInput): Promise<boolean> => {
      const outcome = await store.runOptimisticMutation<{ success: boolean; error?: string }>({
        kind: "card:occurrence:complete",
        conflictKeys: [conflictKeyForCard(input.cardId)],
        apply: buildCompleteOrSkipOccurrenceTransform(input.cardId),
        runRemote: async () => (await invoke(
          "card:occurrence:complete",
          projectId,
          input,
          sessionId,
        )) as { success: boolean; error?: string },
      });

      if (!outcome.ok) return false;
      if (!outcome.result?.success) {
        store.setError(outcome.result?.error ?? "Failed to complete occurrence");
        return false;
      }
      onMutation?.();
      return true;
    },
    [onMutation, projectId, sessionId, store],
  );

  const skipOccurrence = useCallback(
    async (input: CardOccurrenceActionInput): Promise<boolean> => {
      const outcome = await store.runOptimisticMutation<{ success: boolean; error?: string }>({
        kind: "card:occurrence:skip",
        conflictKeys: [conflictKeyForCard(input.cardId)],
        apply: buildCompleteOrSkipOccurrenceTransform(input.cardId),
        runRemote: async () => (await invoke(
          "card:occurrence:skip",
          projectId,
          input,
          sessionId,
        )) as { success: boolean; error?: string },
      });

      if (!outcome.ok) return false;
      if (!outcome.result?.success) {
        store.setError(outcome.result?.error ?? "Failed to skip occurrence");
        return false;
      }
      onMutation?.();
      return true;
    },
    [onMutation, projectId, sessionId, store],
  );

  const updateOccurrence = useCallback(
    async (input: CardOccurrenceUpdateInput): Promise<boolean> => {
      const optimisticPatch = normalizeOccurrenceUpdatesToCardPatch(input);
      const outcome = await store.runOptimisticMutation<{ success: boolean; error?: string }>({
        kind: "card:occurrence:update",
        conflictKeys: conflictKeysForPatch(input.cardId, optimisticPatch),
        apply: buildPatchCardTransform(undefined, input.cardId, optimisticPatch),
        runRemote: async () => (await invoke(
          "card:occurrence:update",
          projectId,
          input,
          sessionId,
        )) as { success: boolean; error?: string },
      });

      if (!outcome.ok) return false;
      if (!outcome.result?.success) {
        store.setError(outcome.result?.error ?? "Failed to update occurrence");
        return false;
      }
      onMutation?.();
      return true;
    },
    [onMutation, projectId, sessionId, store],
  );

  const patchCard = useCallback(
    (columnId: string, cardId: string, updates: Partial<CardInput>) => {
      store.enqueueLocalOverlay({
        kind: "card:patch-local",
        conflictKeys: conflictKeysForPatch(cardId, updates),
        apply: buildPatchCardTransform(columnId, cardId, updates),
      });
    },
    [store],
  );

  const clearLastMutationError = useCallback(() => {
    store.clearLastMutationError();
  }, [store]);

  return {
    board: snapshot.board,
    cardIndex: snapshot.cardIndex,
    loading: snapshot.loading,
    error: snapshot.error,
    pendingMutationCount: snapshot.pendingMutationCount,
    lastMutationError: snapshot.lastMutationError,
    clearLastMutationError,
    refresh: fetchBoard,
    createCard,
    getCard,
    updateCard,
    deleteCard,
    moveCard,
    moveCards,
    moveCardToProject,
    importBlockDrop,
    moveCardDropToEditor,
    listCalendarOccurrences,
    completeOccurrence,
    skipOccurrence,
    updateOccurrence,
    patchCard,
  };
}
