import type { FloatingUIOptions } from "@blocknote/react";
import { flip, offset, shift, type OffsetOptions } from "@floating-ui/react";
import { APP_SHELL_EDITOR_FLOATING_UI_LAYER_INDEX } from "@/lib/app-shell-layers";

/** Try the opposite side before overlapping an anchor that leaves neither side enough room. */
export function createNfmEditorFloatingMiddleware(distance: OffsetOptions, padding = 8) {
  return [
    offset(distance),
    flip({ padding, crossAxis: false }),
    shift({ padding, crossAxis: true }),
  ];
}

/**
 * Interactive editor chrome must escape scroll containers and modal clipping.
 * `null` is BlockNote's explicit document.body portal target.
 */
export const NFM_EDITOR_FLOATING_UI_PORTAL_ELEMENT: HTMLElement | null = null;
export const NFM_EDITOR_FLOATING_UI_Z_INDEX = APP_SHELL_EDITOR_FLOATING_UI_LAYER_INDEX;

export const NFM_SUGGESTION_MENU_PORTAL_ELEMENT = NFM_EDITOR_FLOATING_UI_PORTAL_ELEMENT;
export const NFM_SUGGESTION_MENU_Z_INDEX = NFM_EDITOR_FLOATING_UI_Z_INDEX;
export const NFM_SUGGESTION_MENU_TOOLTIP_Z_INDEX = NFM_SUGGESTION_MENU_Z_INDEX + 1;

export const NFM_SUGGESTION_MENU_FLOATING_OPTIONS = {
  useFloatingOptions: {
    strategy: "fixed",
  },
  elementProps: {
    style: {
      zIndex: NFM_SUGGESTION_MENU_Z_INDEX,
    },
  },
} satisfies FloatingUIOptions;
