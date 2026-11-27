import type { GlobalDictationDeclineReason } from "../../../../../shared/global-dictation";

/** A mounted composer may claim global dictation only while it is the user's actual edit target. */
export function resolveComposerGlobalDictationAdmission(input: {
  readonly visible: boolean;
  readonly editor: HTMLElement | null;
}): GlobalDictationDeclineReason | null {
  if (
    !input.visible ||
    input.editor?.ownerDocument.visibilityState === "hidden" ||
    input.editor?.closest('[hidden], [aria-hidden="true"], [inert], [data-base-ui-inert]') ||
    input.editor?.checkVisibility?.({ visibilityProperty: true }) === false
  )
    return "hidden";
  const activeElement = input.editor?.ownerDocument.activeElement;
  if (
    !input.editor ||
    !activeElement ||
    (activeElement !== input.editor && !input.editor.contains(activeElement))
  ) {
    return "focus-not-owned";
  }
  return null;
}
