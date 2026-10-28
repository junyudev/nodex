import type { DropCursorOptions } from "@blocknote/core/extensions";

/** Keep native cursor geometry aligned with the editor-owned insertion feedback. */
export const NFM_DROP_CURSOR_OPTIONS = {
  width: 3,
  color: false,
} as const satisfies DropCursorOptions;
