const MIN_VISIBLE_MS = 8_000;
const MAX_VISIBLE_MS = 20_000;
const BASE_VISIBLE_MS = 5_000;
/** About as long as reading one character of prose takes. */
const PER_CHARACTER_MS = 50;
/** The clamped preview shows roughly this much; reading further means hovering, which pauses. */
const PREVIEW_CHARACTERS = 320;

/**
 * How long a Readback stays on screen while nobody is attending to it: long enough to read its
 * preview, 8 to 20 seconds. The clock only runs while its window is focused and the stack is
 * neither hovered nor focused.
 */
export function readbackVisibleDuration(text: string): number {
  const readable = Math.min(text.trim().length, PREVIEW_CHARACTERS);
  return Math.min(
    MAX_VISIBLE_MS,
    Math.max(MIN_VISIBLE_MS, BASE_VISIBLE_MS + readable * PER_CHARACTER_MS),
  );
}
