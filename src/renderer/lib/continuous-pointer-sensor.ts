import type { PointerEvent as ReactPointerEvent } from "react";
import type {
  PointerActivationConstraint,
  DistanceMeasurement,
  PointerSensorOptions,
  PointerSensorProps,
} from "@dnd-kit/core";
import { getEventCoordinates, getOwnerDocument } from "@dnd-kit/utilities";

const stopPropagation = (event: Event): void => event.stopPropagation();
const preventDefault = (event: Event): void => event.preventDefault();

const isDistanceConstraint = (
  constraint: PointerActivationConstraint | undefined,
): constraint is Extract<PointerActivationConstraint, { distance: unknown }> =>
  Boolean(constraint && "distance" in constraint);

const hasReachedDistance = (
  delta: { readonly x: number; readonly y: number },
  threshold: DistanceMeasurement,
): boolean => {
  const x = Math.abs(delta.x);
  const y = Math.abs(delta.y);
  if (typeof threshold === "number") return Math.hypot(x, y) >= threshold;
  if ("x" in threshold && "y" in threshold) return x >= threshold.x && y >= threshold.y;
  if ("x" in threshold) return x >= threshold.x;
  return y >= threshold.y;
};

/**
 * Dnd Kit's stock pointer sensor activates on the threshold-crossing move but
 * returns before forwarding that move. The dragged surface therefore pauses,
 * then jumps by the accumulated delta on the next pointer event. This scoped
 * sensor forwards the activation event's coordinates immediately, preserving
 * the click-vs-drag threshold without introducing a dead frame.
 */
export class ContinuousPointerSensor {
  static activators = [
    {
      eventName: "onPointerDown" as const,
      handler: (
        { nativeEvent: event }: ReactPointerEvent,
        { onActivation }: PointerSensorOptions,
      ): boolean => {
        if (!event.isPrimary || event.button !== 0) return false;
        onActivation?.({ event });
        return true;
      },
    },
  ];

  readonly autoScrollEnabled = true;
  private readonly props: PointerSensorProps;
  private readonly document: Document;
  private readonly ownerWindow: Window;
  private readonly initialCoordinates: { readonly x: number; readonly y: number } | null;
  private activated = false;
  private detached = false;

  constructor(props: PointerSensorProps) {
    this.props = props;
    this.document = getOwnerDocument(props.event.target);
    this.ownerWindow = this.document.defaultView ?? window;
    this.initialCoordinates = getEventCoordinates(props.event);
    this.attach();
  }

  private attach = (): void => {
    this.document.addEventListener("pointermove", this.handleMove, { passive: false });
    this.document.addEventListener("pointerup", this.handleEnd);
    this.document.addEventListener("pointercancel", this.handleCancel);
    this.document.addEventListener("keydown", this.handleKeyDown);
    this.ownerWindow.addEventListener("resize", this.handleCancel);
    this.ownerWindow.addEventListener("visibilitychange", this.handleCancel);
    this.ownerWindow.addEventListener("dragstart", preventDefault);
    this.ownerWindow.addEventListener("contextmenu", preventDefault);

    const constraint = this.props.options.activationConstraint;
    if (!constraint) {
      this.activate();
      return;
    }
    this.props.onPending(this.props.active, constraint, this.initialCoordinates ?? { x: 0, y: 0 });
  };

  private activate = (): void => {
    if (this.activated || !this.initialCoordinates) return;
    this.activated = true;
    this.document.addEventListener("click", stopPropagation, { capture: true });
    this.document.addEventListener("selectionchange", this.removeTextSelection);
    this.removeTextSelection();
    this.props.onStart(this.initialCoordinates);
  };

  private handleMove = (event: PointerEvent): void => {
    if (!this.initialCoordinates) return;
    const coordinates = getEventCoordinates(event);
    if (!coordinates) return;
    const delta = {
      x: coordinates.x - this.initialCoordinates.x,
      y: coordinates.y - this.initialCoordinates.y,
    };

    if (!this.activated) {
      const constraint = this.props.options.activationConstraint;
      if (isDistanceConstraint(constraint) && !hasReachedDistance(delta, constraint.distance)) {
        this.props.onPending(this.props.active, constraint, this.initialCoordinates, delta);
        return;
      }
      this.activate();
    }

    if (!this.activated) return;
    if (event.cancelable) event.preventDefault();
    this.props.onMove(coordinates);
  };

  private handleEnd = (): void => {
    this.detach();
    if (!this.activated) this.props.onAbort(this.props.active);
    this.props.onEnd();
  };

  private handleCancel = (): void => {
    this.detach();
    if (!this.activated) this.props.onAbort(this.props.active);
    this.props.onCancel();
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") this.handleCancel();
  };

  private removeTextSelection = (): void => this.document.getSelection()?.removeAllRanges();

  private detach = (): void => {
    if (this.detached) return;
    this.detached = true;
    this.document.removeEventListener("pointermove", this.handleMove);
    this.document.removeEventListener("pointerup", this.handleEnd);
    this.document.removeEventListener("pointercancel", this.handleCancel);
    this.document.removeEventListener("keydown", this.handleKeyDown);
    this.document.removeEventListener("selectionchange", this.removeTextSelection);
    this.ownerWindow.removeEventListener("resize", this.handleCancel);
    this.ownerWindow.removeEventListener("visibilitychange", this.handleCancel);
    this.ownerWindow.removeEventListener("dragstart", preventDefault);
    this.ownerWindow.removeEventListener("contextmenu", preventDefault);
    window.setTimeout(
      () => this.document.removeEventListener("click", stopPropagation, { capture: true }),
      50,
    );
  };
}
