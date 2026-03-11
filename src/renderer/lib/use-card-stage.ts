import { useCallback, useState } from "react";
import type { CardInput, CardUpdateMutationResult } from "./types";

export interface CardStageHandlers {
  onUpdate: (
    columnId: string,
    cardId: string,
    updates: Partial<CardInput>,
  ) => Promise<CardUpdateMutationResult | void>;
  onPatch: (
    columnId: string,
    cardId: string,
    updates: Partial<CardInput>,
  ) => void;
  onDelete: (columnId: string, cardId: string) => Promise<void>;
  onMove: (fromStatus: string, cardId: string, toStatus: string) => Promise<void>;
  onCompleteOccurrence?: (cardId: string, occurrenceStart: Date) => Promise<void>;
  onSkipOccurrence?: (cardId: string, occurrenceStart: Date) => Promise<void>;
}

export interface CardStageState {
  open: boolean;
  projectId: string;
  cardId: string | null;
}

const INITIAL_STATE: CardStageState = {
  open: false,
  projectId: "",
  cardId: null,
};

export function openCardStageState(
  state: CardStageState,
  projectId: string,
  cardId: string,
): CardStageState {
  const normalizedProjectId = projectId.trim();
  const normalizedCardId = cardId.trim();
  if (!normalizedProjectId || !normalizedCardId) return state;

  if (
    state.open
    && state.projectId === normalizedProjectId
    && state.cardId === normalizedCardId
  ) {
    return state;
  }

  return {
    open: true,
    projectId: normalizedProjectId,
    cardId: normalizedCardId,
  };
}

export function closeCardStageState(state: CardStageState): CardStageState {
  if (!state.open) return state;
  return {
    ...state,
    open: false,
  };
}

function normalizeInitialCardStageState(
  value: CardStageState | null | undefined,
): CardStageState {
  if (!value) return INITIAL_STATE;
  if (typeof value.open !== "boolean") return INITIAL_STATE;
  if (typeof value.projectId !== "string") return INITIAL_STATE;
  if (value.cardId !== null && typeof value.cardId !== "string") return INITIAL_STATE;
  return {
    open: value.open,
    projectId: value.projectId,
    cardId: value.cardId ?? null,
  };
}

export function useCardStageState(initialState?: CardStageState | null) {
  const [state, setState] = useState<CardStageState>(() => normalizeInitialCardStageState(initialState));

  const openCardStage = useCallback((projectId: string, cardId: string) => {
    setState((current) => openCardStageState(current, projectId, cardId));
  }, []);

  const closeCardStage = useCallback(() => {
    setState((current) => closeCardStageState(current));
  }, []);

  const cardStageCardId = state.open ? state.cardId ?? undefined : undefined;

  return {
    state,
    openCardStage,
    closeCardStage,
    cardStageCardId,
  };
}
