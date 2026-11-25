/**
 * Keeps every press with the document it began in, across embedded guest pages.
 *
 * The web platform hands a press's moves and release to the document where the press began,
 * until the button comes up, even while the pointer travels over an `<iframe>`. An Electron
 * `<webview>` breaks that: it takes pointer input in its own process. A press that begins in Nodex
 * and crosses a Browser page loses its moves and its release to the page, so whatever the press
 * was driving (a resize, a reorder, a text selection, a library's own drag) never ends.
 *
 * While a press that began in this document is held, the root carries
 * {@link POINTER_HELD_ROOT_ATTRIBUTE} and `globals.css` takes embedded guests out of hit testing.
 * That restores the platform's contract for every gesture in the renderer without any of them
 * knowing about guests. Native drag and drop ends the press (`pointercancel`, `dragstart`), so a
 * drag into a guest still reaches it. A press that begins inside a guest never reaches this
 * document and is left alone.
 */

/** Present on the root element while a press that began in this document is held. */
export const POINTER_HELD_ROOT_ATTRIBUTE = "data-pointer-held";

/** Installs the boundary on a renderer window; returns its removal. */
export function installGuestPointerBoundary(view: Window): () => void {
  const root = view.document.documentElement;
  const heldPointers = new Set<number>();
  const sync = () => root.toggleAttribute(POINTER_HELD_ROOT_ATTRIBUTE, heldPointers.size > 0);

  const onPress = (event: PointerEvent) => {
    heldPointers.add(event.pointerId);
    sync();
  };
  const onRelease = (event: PointerEvent) => {
    if (heldPointers.delete(event.pointerId)) sync();
  };
  // A release this document never saw, such as one during a system interruption, shows up as the
  // pointer's next move without a button held.
  const onMove = (event: PointerEvent) => {
    if (event.buttons === 0) onRelease(event);
  };
  const onNativeDrag = () => {
    if (heldPointers.size === 0) return;
    heldPointers.clear();
    sync();
  };

  const options = { capture: true, passive: true } as const;
  view.addEventListener("pointerdown", onPress, options);
  view.addEventListener("pointerup", onRelease, options);
  view.addEventListener("pointercancel", onRelease, options);
  view.addEventListener("pointermove", onMove, options);
  view.addEventListener("dragstart", onNativeDrag, options);
  return () => {
    view.removeEventListener("pointerdown", onPress, options);
    view.removeEventListener("pointerup", onRelease, options);
    view.removeEventListener("pointercancel", onRelease, options);
    view.removeEventListener("pointermove", onMove, options);
    view.removeEventListener("dragstart", onNativeDrag, options);
    heldPointers.clear();
    sync();
  };
}
