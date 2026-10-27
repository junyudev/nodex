import { hasOpenNodexFloatingEscapeLayer } from "@/components/ui/floating-surface";

const OPEN_QUESTION_KEYBOARD_LAYER = ["dialog", "menu", "listbox"]
  .flatMap((role) => [`[role="${role}"][data-open]`, `[role="${role}"][data-state="open"]`])
  .join(",");

/** Editors handle their own keys first; accessible overlays retain the remaining shortcuts. */
export function isQuestionKeyboardOverlaid(surface: HTMLElement, key: string): boolean {
  const ownerDocument = surface.ownerDocument;
  if (key === "Escape" && hasOpenNodexFloatingEscapeLayer(ownerDocument)) return true;
  return [...ownerDocument.querySelectorAll(OPEN_QUESTION_KEYBOARD_LAYER)].some(
    (layer) =>
      !layer.contains(surface) &&
      !layer.closest('[hidden], [aria-hidden="true"], [inert], [data-base-ui-inert]'),
  );
}
