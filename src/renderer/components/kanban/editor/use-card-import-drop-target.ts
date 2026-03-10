import { useEffect, useId, useMemo } from "react";
import type { RefObject } from "react";
import {
  registerCardDropTarget,
  type CardDropApplyResult,
} from "./card-drop-target-registry";
import type {
  CardDragPointer,
  ExternalCardDragPayload,
} from "./external-card-drag-session";

interface UseCardImportDropTargetOptions {
  containerRef: RefObject<HTMLElement | null>;
  enabled?: boolean;
  getTargetCardIds: () => string[];
  applyDrop: (
    payload: ExternalCardDragPayload,
    pointer: CardDragPointer,
  ) => CardDropApplyResult | null;
  setHover?: (
    hover: boolean,
    pointer: CardDragPointer | null,
    payload: ExternalCardDragPayload | null,
  ) => void;
}

export function useCardImportDropTarget({
  containerRef,
  enabled = true,
  getTargetCardIds,
  applyDrop,
  setHover,
}: UseCardImportDropTargetOptions): void {
  const autoId = useId();
  const targetId = useMemo(() => `card-import-target-${autoId}`, [autoId]);

  useEffect(() => {
    if (!enabled) return;
    const element = containerRef.current;
    if (!element) return;

    const unregister = registerCardDropTarget({
      id: targetId,
      element,
      canDrop(payload) {
        const targetCardIds = new Set(getTargetCardIds());
        if (payload.cards.some((entry) => targetCardIds.has(entry.card.id))) return false;
        return true;
      },
      setHover: (hover, pointer, payload) => {
        if (hover) {
          element.setAttribute("data-card-drop-hover", "");
        } else {
          element.removeAttribute("data-card-drop-hover");
        }
        setHover?.(hover, pointer, payload);
      },
      applyDrop,
    });

    return unregister;
  }, [applyDrop, containerRef, enabled, getTargetCardIds, setHover, targetId]);
}
