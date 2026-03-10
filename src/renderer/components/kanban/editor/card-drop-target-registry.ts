import type { BlockDropImportSourceUpdate } from "../../../lib/types";
import type { CardDragPointer, ExternalCardDragPayload } from "./external-card-drag-session";

export interface CardDropApplyResult {
  targetUpdates: BlockDropImportSourceUpdate[];
  rollback: () => void;
  cleanup?: () => void;
}

export interface CardDropTargetRegistration {
  id: string;
  element: HTMLElement;
  canDrop: (payload: ExternalCardDragPayload) => boolean;
  setHover?: (
    hover: boolean,
    pointer: CardDragPointer | null,
    payload: ExternalCardDragPayload | null,
  ) => void;
  applyDrop: (
    payload: ExternalCardDragPayload,
    pointer: CardDragPointer,
  ) => CardDropApplyResult | null;
}

const registry = new Map<string, CardDropTargetRegistration>();
let hoveredTargetId: string | null = null;

function includesPoint(rect: DOMRect, pointer: CardDragPointer): boolean {
  return (
    pointer.x >= rect.left
    && pointer.x <= rect.right
    && pointer.y >= rect.top
    && pointer.y <= rect.bottom
  );
}

function resolveFromElementsAtPoint(
  pointer: CardDragPointer,
): CardDropTargetRegistration | null {
  const documentRef = registry.values().next().value?.element.ownerDocument;
  if (!documentRef) return null;

  const elements = documentRef.elementsFromPoint(pointer.x, pointer.y);
  for (const element of elements) {
    for (const target of registry.values()) {
      if (target.element === element || target.element.contains(element)) {
        return target;
      }
    }
  }

  return null;
}

export function registerCardDropTarget(
  target: CardDropTargetRegistration,
): () => void {
  registry.set(target.id, target);

  return () => {
    if (hoveredTargetId === target.id) {
      target.setHover?.(false, null, null);
      hoveredTargetId = null;
    }
    registry.delete(target.id);
  };
}

export function resolveCardDropTargetAtPointer(
  pointer: CardDragPointer | null,
  payload: ExternalCardDragPayload,
): CardDropTargetRegistration | null {
  if (!pointer) return null;

  const fromElements = resolveFromElementsAtPoint(pointer);
  if (fromElements && fromElements.canDrop(payload)) {
    return fromElements;
  }

  for (const target of registry.values()) {
    if (!target.canDrop(payload)) continue;
    if (!includesPoint(target.element.getBoundingClientRect(), pointer)) continue;
    return target;
  }

  return null;
}

export function updateCardDropTargetHover(
  pointer: CardDragPointer | null,
  payload: ExternalCardDragPayload | null,
): CardDropTargetRegistration | null {
  if (!pointer || !payload) {
    clearCardDropTargetHover();
    return null;
  }

  const nextTarget = resolveCardDropTargetAtPointer(pointer, payload);
  const previousTarget = hoveredTargetId ? registry.get(hoveredTargetId) ?? null : null;

  if (previousTarget && (!nextTarget || previousTarget.id !== nextTarget.id)) {
    previousTarget.setHover?.(false, null, null);
    hoveredTargetId = null;
  }

  if (nextTarget) {
    hoveredTargetId = nextTarget.id;
    nextTarget.setHover?.(true, pointer, payload);
    return nextTarget;
  }

  return null;
}

export function clearCardDropTargetHover(): void {
  if (!hoveredTargetId) return;
  const target = registry.get(hoveredTargetId);
  target?.setHover?.(false, null, null);
  hoveredTargetId = null;
}
