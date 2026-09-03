import type { FloatingUIOptions } from "@blocknote/react";
import { APP_SHELL_EDITOR_FLOATING_UI_LAYER_INDEX } from "@/lib/app-shell-layers";

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
