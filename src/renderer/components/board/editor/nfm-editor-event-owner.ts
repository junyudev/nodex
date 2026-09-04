import { NESTED_EDITOR_EVENT_BOUNDARY_ATTRIBUTE } from "@blocknote/core";

/** Capture-phase shortcuts must respect the same surface boundary as NodeViews. */
export function ownsNfmEditorEvent(container: HTMLElement, target: EventTarget | null): boolean {
  if (!(target instanceof Element) || !container.contains(target)) return false;
  const nearestEditor = target.closest(".nfm-editor");
  if (nearestEditor && nearestEditor !== container) return false;
  const boundary = target.closest(
    `[${NESTED_EDITOR_EVENT_BOUNDARY_ATTRIBUTE}], [data-embedded-surface-input]`,
  );
  // A wrapper outside this editor belongs to its parent, not to its own body.
  return !boundary || !container.contains(boundary);
}
