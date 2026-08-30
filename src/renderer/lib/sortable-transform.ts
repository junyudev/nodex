import { CSS, type Transform } from "@dnd-kit/utilities";

/**
 * Serializes sortable motion as translation only.
 *
 * Dnd Kit includes the hovered target's size ratio in a draggable transform.
 * That scale is useful for some free-form layouts, but it distorts variable-size
 * rows and rails. Their content owns its dimensions; sorting only moves it.
 */
export function serializeSortableTranslation(transform: Transform | null): string | undefined {
  return CSS.Translate.toString(transform);
}
