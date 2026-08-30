import {
  DragOverlay,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type Modifier,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import type { Transform } from "@dnd-kit/utilities";
import { createPortal } from "react-dom";
import { useMemo, type CSSProperties, type ReactNode, type RefObject } from "react";

import { ContinuousPointerSensor } from "@/lib/continuous-pointer-sensor";
import { serializeSortableTranslation } from "@/lib/sortable-transform";
import { useResolvedReducedMotion } from "@/lib/use-reduced-motion";

const ACTIVATION_DISTANCE = 6;
const SIBLING_TRANSITION = { duration: 200, easing: "ease" } as const;

export type ContinuousSortableAxis = "horizontal" | "vertical";

interface DragRect {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/**
 * Constrains the dragged surface by its own rectangle, so the bounds remain
 * stable regardless of where inside the surface the pointer was pressed.
 */
export function constrainContinuousDragTransform(
  axis: ContinuousSortableAxis,
  transform: Transform,
  activeRect: DragRect | null,
  containerRect: DragRect | null,
): Transform {
  if (!activeRect || !containerRect) {
    return axis === "horizontal" ? { ...transform, y: 0 } : { ...transform, x: 0 };
  }

  if (axis === "horizontal") {
    const minimum = containerRect.left - activeRect.left;
    const maximum = Math.max(minimum, containerRect.right - activeRect.right);
    return {
      ...transform,
      x: Math.min(maximum, Math.max(minimum, transform.x)),
      y: 0,
    };
  }

  const minimum = containerRect.top - activeRect.top;
  const maximum = Math.max(minimum, containerRect.bottom - activeRect.bottom);
  return {
    ...transform,
    x: 0,
    y: Math.min(maximum, Math.max(minimum, transform.y)),
  };
}

const continuousPointerCollisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  return pointerCollisions.length > 0 ? pointerCollisions : closestCenter(args);
};

interface ContinuousSortableDndOptions {
  readonly axis: ContinuousSortableAxis;
  readonly containerRef: RefObject<HTMLElement | null>;
}

/** Owns Nodex's shared pointer threshold, collision policy, axis lock, and exact bounds. */
export function useContinuousSortableDnd({ axis, containerRef }: ContinuousSortableDndOptions) {
  const sensors = useSensors(
    useSensor(ContinuousPointerSensor, {
      activationConstraint: { distance: ACTIVATION_DISTANCE },
    }),
  );
  const modifiers = useMemo<Modifier[]>(
    () => [
      ({ activeNodeRect, transform }) =>
        constrainContinuousDragTransform(
          axis,
          transform,
          activeNodeRect,
          containerRef.current?.getBoundingClientRect() ?? null,
        ),
    ],
    [axis, containerRef],
  );

  return { collisionDetection: continuousPointerCollisionDetection, modifiers, sensors };
}

export function useContinuousSortable({
  id,
  disabled = false,
}: {
  readonly id: UniqueIdentifier;
  readonly disabled?: boolean;
}) {
  const reducedMotion = useResolvedReducedMotion();
  const sortable = useSortable({
    id,
    disabled,
    transition: reducedMotion ? null : SIBLING_TRANSITION,
  });
  const style: CSSProperties = {
    transform: serializeSortableTranslation(sortable.transform),
    // The active surface follows every pointer sample; only its siblings ease
    // into newly reserved positions.
    transition: sortable.isDragging ? undefined : sortable.transition,
    zIndex: sortable.isDragging ? 1 : undefined,
  };

  return { ...sortable, style };
}

export function ContinuousSortableDragOverlay({ children }: { readonly children: ReactNode }) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <DragOverlay adjustScale={false} dropAnimation={null} zIndex={1000}>
      {children}
    </DragOverlay>,
    document.body,
  );
}
