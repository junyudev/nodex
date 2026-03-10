/** Centralized timing constants (milliseconds) */

/** Debounce delay for text field saves (title, assignee, agent status, description) */
export const FIELD_SAVE_DEBOUNCE_MS = 500;

/** Debounce delay for toggle-list card editor outbound sync */
export const EDITOR_SYNC_DEBOUNCE_MS = 400;

/** Auto-dismiss delay for undo/redo toast */
export const TOAST_DISMISS_MS = 2700;

/** Delay before clearing last-action state (toast lifecycle) */
export const TOAST_CLEANUP_MS = 3000;

/** Blur delay for tag dropdown (allows click on items before closing) */
export const TAG_BLUR_DELAY_MS = 150;

/** Debounce delay for persisting card-stage scroll position on scroll */
export const SCROLL_SAVE_DEBOUNCE_MS = 300;
