import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";

/**
 * Window-spanning pointer drags: resize handles and sashes that follow a pressed pointer wherever
 * it travels.
 *
 * The press can be released where this document never hears about it: over an embedded guest page
 * (a Browser `<webview>` or an `<iframe>`, which take pointer input in their own process), outside
 * the window, or behind a system interruption. A drag that waits only for `pointerup` then stays
 * attached to a pointer whose button is already up, and the handle keeps following it.
 *
 * A drag therefore keeps the pointer in this document for its whole duration, by marking the root
 * with {@link POINTER_DRAG_ROOT_ATTRIBUTE} so embedded guests stop taking pointer input (see
 * `globals.css`), and treats any later event from the pointer that no longer holds the button as
 * the release it missed.
 */

/** How a drag finished. */
export type PointerDragEnd =
  /** The button was released, whether this document saw the release or inferred it afterwards. */
  | "release"
  /** The platform cancelled the pointer (`pointercancel`). */
  | "cancel"
  /** The drag's owner disposed it, for example by unmounting, before the pointer finished. */
  | "dispose";

export interface PointerDragHandlers {
  /** The pressed pointer moved. */
  readonly onMove: (event: PointerEvent) => void;
  /**
   * Runs exactly once. A release, seen or inferred, commits where the last `onMove` left the
   * handle: that is where the person saw it when they let go.
   */
  readonly onEnd?: (end: PointerDragEnd) => void;
}

export interface PointerDrag {
  /** Ends the drag as `"dispose"`; does nothing once it has ended. */
  readonly dispose: () => void;
}

/** Present on the root element while a drag holds the pointer. */
export const POINTER_DRAG_ROOT_ATTRIBUTE = "data-pointer-drag";

const PRIMARY_BUTTON = 0;
const PRIMARY_BUTTON_MASK = 1;

const documentHolds = new WeakMap<Document, number>();

/**
 * Marks the document as dragging and shows the handle's cursor everywhere, until the returned
 * release runs.
 */
function holdDocument(handle: Element, view: Window): () => void {
  const document = handle.ownerDocument;
  const root = document.documentElement;
  const cursor = view.getComputedStyle(handle).cursor;
  documentHolds.set(document, (documentHolds.get(document) ?? 0) + 1);
  root.setAttribute(POINTER_DRAG_ROOT_ATTRIBUTE, "");
  if (cursor && cursor !== "auto") root.style.cursor = cursor;

  let held = true;
  return () => {
    if (!held) return;
    held = false;
    const remaining = (documentHolds.get(document) ?? 1) - 1;
    if (remaining > 0) {
      documentHolds.set(document, remaining);
      return;
    }
    documentHolds.delete(document);
    root.removeAttribute(POINTER_DRAG_ROOT_ATTRIBUTE);
    root.style.removeProperty("cursor");
  };
}

/**
 * Starts a drag from a primary-button press on a handle. Returns `null`, leaving the event
 * untouched, for any other press.
 */
export function startPointerDrag(
  press: ReactPointerEvent | PointerEvent,
  handlers: PointerDragHandlers,
): PointerDrag | null {
  if (press.button !== PRIMARY_BUTTON) return null;
  const handle = press.currentTarget;
  if (!(handle instanceof Element)) return null;
  const view = handle.ownerDocument.defaultView;
  if (!view) return null;
  press.preventDefault();

  const { pointerId } = press;
  let active = true;
  const releaseDocument = holdDocument(handle, view);
  try {
    handle.setPointerCapture?.(pointerId);
  } catch {
    // Capture only keeps targeting on the handle; the window listeners below own the drag.
  }

  const finish = (end: PointerDragEnd) => {
    if (!active) return;
    active = false;
    view.removeEventListener("pointermove", onPointerMove, true);
    view.removeEventListener("pointerup", onPointerUp, true);
    view.removeEventListener("pointercancel", onPointerCancel, true);
    view.removeEventListener("pointerdown", onPointerDown, true);
    if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
    releaseDocument();
    handlers.onEnd?.(end);
  };

  function onPointerMove(event: PointerEvent) {
    if (event.pointerId !== pointerId) return;
    // The button came up where this document could not see it. Where the pointer is now is not
    // where it was released, so end at the last position instead of following it.
    if ((event.buttons & PRIMARY_BUTTON_MASK) === 0) {
      finish("release");
      return;
    }
    event.preventDefault();
    handlers.onMove(event);
  }

  function onPointerUp(event: PointerEvent) {
    if (event.pointerId !== pointerId) return;
    event.preventDefault();
    finish("release");
  }

  function onPointerCancel(event: PointerEvent) {
    if (event.pointerId !== pointerId) return;
    finish("cancel");
  }

  // A new press from the same pointer proves the previous release was missed.
  function onPointerDown(event: PointerEvent) {
    if (event.pointerId !== pointerId) return;
    finish("release");
  }

  view.addEventListener("pointermove", onPointerMove, true);
  view.addEventListener("pointerup", onPointerUp, true);
  view.addEventListener("pointercancel", onPointerCancel, true);
  view.addEventListener("pointerdown", onPointerDown, true);

  return { dispose: () => finish("dispose") };
}

/**
 * Starts pointer drags owned by a component: a new drag disposes the previous one, and unmounting
 * disposes the active drag. Returns whether the press started a drag.
 */
export function usePointerDrag(): (
  press: ReactPointerEvent,
  handlers: PointerDragHandlers,
) => boolean {
  const activeRef = useRef<PointerDrag | null>(null);
  useEffect(
    () => () => {
      activeRef.current?.dispose();
      activeRef.current = null;
    },
    [],
  );
  return useCallback((press, handlers) => {
    const drag = startPointerDrag(press, handlers);
    if (!drag) return false;
    activeRef.current?.dispose();
    activeRef.current = drag;
    return true;
  }, []);
}
