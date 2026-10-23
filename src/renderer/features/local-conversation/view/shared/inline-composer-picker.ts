import type { KeyboardEvent } from "react";

/** Composer picker rows share their inset shape and icon-to-label spacing. */
export const COMPOSER_PICKER_ITEM_CLASS_NAME = "rounded-xl [&>div]:gap-1.5";

/** Presents an existing picker inside the Composer configuration surface. */
export interface InlineComposerPickerPresentation {
  readonly container: HTMLElement | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/** A replacement picker returns to its owning settings page before popup dismissal. */
export function handleInlineComposerPickerKeyDown(
  event: KeyboardEvent,
  inline: InlineComposerPickerPresentation | undefined,
): void {
  if (
    !inline ||
    event.key !== "Escape" ||
    event.nativeEvent.isComposing ||
    event.nativeEvent.keyCode === 229
  )
    return;
  event.preventDefault();
  event.stopPropagation();
  inline.onOpenChange(false);
}

/** Search editors hand list navigation to the picker without menu typeahead. */
export function handleComposerPickerSearchKeyDown(
  event: KeyboardEvent<HTMLInputElement>,
  pending = false,
): void {
  if (!["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) return;
  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
  event.preventDefault();
  if (pending) return;
  const options = event.currentTarget
    .closest("[data-composer-picker]")
    ?.querySelectorAll<HTMLElement>(
      '[data-composer-picker-option="true"]:not([aria-disabled="true"])',
    );
  if (!options?.length) return;
  const option = options[event.key === "ArrowUp" ? options.length - 1 : 0];
  if (event.key === "Enter") option?.click();
  else option?.focus();
}
