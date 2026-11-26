import { APP_SHELL_FLOATING_UI_LAYER_CLASS } from "@/lib/app-shell-layers";
import { cn } from "@/lib/utils";

/** Visual chrome shared by positioned Dropdown and ContextMenu surface owners. */
export const nodexMenuSurfaceClassName = cn(
  "no-drag m-px flex select-none flex-col overflow-x-hidden overflow-y-auto rounded-2xl bg-(--menu-background-color) px-1 py-1 text-token-foreground shadow-xl-spread ring-[0.5px] ring-token-border backdrop-blur-sm",
  APP_SHELL_FLOATING_UI_LAYER_CLASS,
);
