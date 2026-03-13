import { computeNativeDropIndexFromSurface } from "./native-drop-index";

interface DragPointerRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface DragPointerEventLike {
  activatorEvent: Event | null;
  delta: {
    x: number;
    y: number;
  };
  active: {
    rect: {
      current: {
        initial: DragPointerRect | null;
        translated: DragPointerRect | null;
      };
    };
  };
}

interface DragPointer {
  x: number;
  y: number;
}

interface ClientPointerEvent extends Event {
  clientX: number;
  clientY: number;
}

function isClientPointerEvent(event: Event): event is ClientPointerEvent {
  const candidate = event as Partial<ClientPointerEvent>;
  return typeof candidate.clientX === "number"
    && typeof candidate.clientY === "number";
}

function resolveEventPointer(event: Event | null): DragPointer | null {
  if (!event) return null;

  if (isClientPointerEvent(event)) {
    return {
      x: event.clientX,
      y: event.clientY,
    };
  }

  return null;
}

function resolveRectCenter(rect: DragPointerRect | null): DragPointer | null {
  if (!rect) return null;

  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
}

export function resolveDragPointer(event: DragPointerEventLike): DragPointer | null {
  const eventPointer = resolveEventPointer(event.activatorEvent);
  if (eventPointer) {
    return {
      x: eventPointer.x + event.delta.x,
      y: eventPointer.y + event.delta.y,
    };
  }

  return resolveRectCenter(
    event.active.rect.current.translated ?? event.active.rect.current.initial,
  );
}

export function resolveColumnDropIndex(args: {
  surface: HTMLElement | null;
  fallbackIndex: number;
  event: DragPointerEventLike;
}): number {
  const pointer = resolveDragPointer(args.event);
  if (!args.surface || !pointer) {
    return args.fallbackIndex;
  }

  return computeNativeDropIndexFromSurface(args.surface, pointer.y);
}
