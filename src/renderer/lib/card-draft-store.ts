import { useCallback, useSyncExternalStore } from "react";
import type { CardInput } from "./types";

export type CardDraftOverlay = Pick<Partial<CardInput>, "title" | "description" | "assignee" | "agentStatus">;

type StoreListener = () => void;

const EMPTY_CARD_DRAFT: CardDraftOverlay = Object.freeze({});

function buildDraftKey(projectId: string, cardId: string): string {
  return `${projectId}:${cardId}`;
}

function normalizeDraftOverlay(overlay: CardDraftOverlay): CardDraftOverlay {
  const next: CardDraftOverlay = {};

  if (typeof overlay.title === "string") next.title = overlay.title;
  if (typeof overlay.description === "string") next.description = overlay.description;
  if (typeof overlay.assignee === "string") next.assignee = overlay.assignee;
  if (typeof overlay.agentStatus === "string") next.agentStatus = overlay.agentStatus;

  return next;
}

function hasDraftOverlay(overlay: CardDraftOverlay): boolean {
  return Object.keys(overlay).length > 0;
}

function areDraftOverlaysEqual(left: CardDraftOverlay, right: CardDraftOverlay): boolean {
  return left.title === right.title
    && left.description === right.description
    && left.assignee === right.assignee
    && left.agentStatus === right.agentStatus;
}

class CardDraftStore {
  private readonly overlays = new Map<string, CardDraftOverlay>();

  private readonly listeners = new Map<string, Set<StoreListener>>();

  get(projectId: string, cardId: string): CardDraftOverlay {
    return this.overlays.get(buildDraftKey(projectId, cardId)) ?? EMPTY_CARD_DRAFT;
  }

  set(projectId: string, cardId: string, overlay: CardDraftOverlay): void {
    const key = buildDraftKey(projectId, cardId);
    const normalized = normalizeDraftOverlay(overlay);
    const previous = this.overlays.get(key) ?? EMPTY_CARD_DRAFT;

    if (!hasDraftOverlay(normalized)) {
      if (previous === EMPTY_CARD_DRAFT) return;
      this.overlays.delete(key);
      this.emit(key);
      return;
    }

    if (areDraftOverlaysEqual(previous, normalized)) return;
    this.overlays.set(key, normalized);
    this.emit(key);
  }

  clear(projectId: string, cardId: string): void {
    const key = buildDraftKey(projectId, cardId);
    if (!this.overlays.has(key)) return;
    this.overlays.delete(key);
    this.emit(key);
  }

  subscribe(projectId: string, cardId: string, listener: StoreListener): () => void {
    const key = buildDraftKey(projectId, cardId);
    const listeners = this.listeners.get(key) ?? new Set<StoreListener>();
    listeners.add(listener);
    this.listeners.set(key, listeners);

    return () => {
      const current = this.listeners.get(key);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(key);
      }
    };
  }

  reset(): void {
    this.overlays.clear();
    this.listeners.clear();
  }

  private emit(key: string): void {
    const listeners = this.listeners.get(key);
    if (!listeners) return;

    for (const listener of listeners) {
      listener();
    }
  }
}

const cardDraftStore = new CardDraftStore();

export function setCardDraftOverlay(projectId: string, cardId: string, overlay: CardDraftOverlay): void {
  if (projectId.length === 0 || cardId.length === 0) return;
  cardDraftStore.set(projectId, cardId, overlay);
}

export function clearCardDraftOverlay(projectId: string, cardId: string): void {
  if (projectId.length === 0 || cardId.length === 0) return;
  cardDraftStore.clear(projectId, cardId);
}

export function getCardDraftOverlay(projectId: string, cardId: string): CardDraftOverlay | null {
  if (projectId.length === 0 || cardId.length === 0) return null;
  const overlay = cardDraftStore.get(projectId, cardId);
  return overlay === EMPTY_CARD_DRAFT ? null : overlay;
}

export function useCardDraftOverlay(projectId?: string, cardId?: string): CardDraftOverlay | null {
  const resolvedProjectId = projectId?.trim() ?? "";
  const resolvedCardId = cardId?.trim() ?? "";
  const canSubscribe = resolvedProjectId.length > 0 && resolvedCardId.length > 0;

  const subscribe = useCallback((listener: StoreListener) => {
    if (!canSubscribe) return () => undefined;
    return cardDraftStore.subscribe(resolvedProjectId, resolvedCardId, listener);
  }, [canSubscribe, resolvedCardId, resolvedProjectId]);

  const getSnapshot = useCallback(() => {
    if (!canSubscribe) return EMPTY_CARD_DRAFT;
    return cardDraftStore.get(resolvedProjectId, resolvedCardId);
  }, [canSubscribe, resolvedCardId, resolvedProjectId]);

  const overlay = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return overlay === EMPTY_CARD_DRAFT ? null : overlay;
}

export function mergeCardDraftOverlay<T extends object>(
  value: T | null | undefined,
  overlay: CardDraftOverlay | null | undefined,
): T | null {
  if (!value) return null;
  if (!overlay || !hasDraftOverlay(overlay)) return value;
  return {
    ...value,
    ...overlay,
  };
}

export function resetCardDraftStoreForTest(): void {
  cardDraftStore.reset();
}
