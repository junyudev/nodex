import type { FloatingUIOptions } from "@blocknote/react";
import {
  createNfmEditorFloatingMiddleware,
  NFM_EDITOR_FLOATING_UI_Z_INDEX,
} from "./nfm-blocknote-floating-ui";

export const NFM_TEXT_ACTION_MENU_FLOATING_OPTIONS = {
  useFloatingOptions: {
    placement: "bottom-start",
    strategy: "fixed",
    transform: false,
    middleware: createNfmEditorFloatingMiddleware(({ rects }) => ({
      crossAxis: rects.reference.width,
    })),
  },
  useTransitionStylesProps: {
    duration: {
      open: 100,
      close: 100,
    },
    initial: {
      opacity: 0,
      transform: "scale(0.97)",
    },
    open: {
      opacity: 1,
      transform: "scale(1)",
    },
    close: {
      opacity: 0,
      transform: "scale(0.97)",
    },
    common: {
      transitionTimingFunction: "ease",
      transitionDelay: "30ms",
      transformOrigin: "112px center",
      willChange: "opacity, transform",
    },
  },
  focusManagerProps: {
    disabled: true,
  },
  elementProps: {
    className: "notion-text-action-menu pointer-events-none",
    style: {
      zIndex: NFM_EDITOR_FLOATING_UI_Z_INDEX,
      transformOrigin: "112px center",
    },
  },
} satisfies FloatingUIOptions;
