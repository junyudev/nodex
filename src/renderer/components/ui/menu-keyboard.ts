import type { KeyboardEvent } from "react";

/** Embedded editors own text and caret keys before menu typeahead/navigation.
 * Run on the popup in bubble phase so the editor's own handlers still run.
 * Unhandled Escape remains available to the menu's dismissal machinery.
 */
export function handleMenuEditorKeyDown(
  event: KeyboardEvent<HTMLElement> & { preventBaseUIHandler(): void },
) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const editor = target.closest(
    'input, textarea, [contenteditable], [role="combobox"], [role="searchbox"], [role="textbox"]',
  );
  if (!editor || editor.getAttribute("contenteditable") === "false") return;
  if (
    editor instanceof HTMLInputElement &&
    ["button", "checkbox", "radio", "reset", "submit"].includes(editor.type)
  )
    return;
  const composing = event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
  if (event.key === "Escape" && !event.defaultPrevented && !composing) return;
  event.preventBaseUIHandler();
  event.stopPropagation();
}
