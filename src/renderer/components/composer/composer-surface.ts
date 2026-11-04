/**
 * The surface a composer's rows sit on: its elevation, its fill, and the corner radius an
 * attachment inside it nests against.
 */
export const COMPOSER_SURFACE_CLASS_NAME =
  "composer-surface-chrome composer-multiline-surface bg-background-composer-surface";

/** What a composer's prompt is written in, whichever editor holds it. */
export const COMPOSER_PROMPT_TEXT_CLASS_NAME =
  "font-sans text-size-chat leading-(--composer-prompt-line-height,1.25rem) text-token-foreground";

/**
 * How far a composer's prompt grows before it scrolls. The prompt is its own scroller, in its own
 * row, so the controls beneath it never move and the scrollbar never runs beside them.
 */
export const COMPOSER_PROMPT_SCROLL_CLASS_NAME = "max-h-[25dvh] overflow-y-auto";

/**
 * Marks a composer while a drag it takes is over it. An outline, because the surface's elevation
 * owns its box-shadow; it follows the composer's corners with the same radius.
 */
export const COMPOSER_DROP_TARGET_CLASS_NAME =
  "rounded-3xl outline-2 outline-offset-2 outline-token-focus-border";
