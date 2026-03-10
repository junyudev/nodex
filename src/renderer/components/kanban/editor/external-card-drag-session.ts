import type { Card } from "../../../lib/types";

export interface CardDragPointer {
  x: number;
  y: number;
}

export interface ExternalCardDragItem {
  card: Card;
  columnId: string;
  columnName: string;
}

export interface ExternalCardDragPayload {
  projectId: string;
  cards: ExternalCardDragItem[];
}

export interface ExternalCardDragSession {
  id: string;
  payload: ExternalCardDragPayload;
  pointer: CardDragPointer | null;
}

let activeSession: ExternalCardDragSession | null = null;

export function startExternalCardDragSession(
  payload: ExternalCardDragPayload,
): string {
  const id = crypto.randomUUID();
  activeSession = {
    id,
    payload,
    pointer: null,
  };
  return id;
}

export function getActiveExternalCardDragSession(): ExternalCardDragSession | null {
  return activeSession;
}

export function updateExternalCardDragPointer(
  sessionId: string | undefined,
  pointer: CardDragPointer | null,
): void {
  if (!activeSession) return;
  if (sessionId && activeSession.id !== sessionId) return;
  activeSession.pointer = pointer;
}

export function endExternalCardDragSession(sessionId?: string): void {
  if (!activeSession) return;
  if (sessionId && activeSession.id !== sessionId) return;
  activeSession = null;
}
