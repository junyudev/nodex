/**
 * Named layers for fixed or body-portalled surfaces. They are compared in one stacking context,
 * the document root: Browser pages mount on `document.body` because moving a guest in the DOM
 * reloads it, so the app shell never isolates itself from them. A surface that covers the shell
 * takes a layer here instead.
 */
export const APP_SHELL_RIGHT_PANEL_LAYER_CLASS = "z-[41]";
/** Web content sits directly above the panel that frames it and below all other app chrome. */
export const APP_SHELL_BROWSER_WEBVIEW_LAYER_INDEX = 42;
export const APP_SHELL_GLOBAL_HEADER_LAYER_CLASS = "z-[43]";
export const APP_SHELL_RIGHT_PANEL_COMPOSER_OVERLAY_LAYER_CLASS = "z-[43]";
export const APP_SHELL_FLOATING_LEFT_PANEL_LAYER_CLASS = "z-[44]";
export const APP_SHELL_APPLICATION_MENU_LAYER_CLASS = "z-[45]";
/** Readbacks float over the workspace but under menus, tooltips and dialogs opened from it. */
export const APP_SHELL_READBACK_LAYER_INDEX = 50;
/** Setup covers the whole workspace, Readbacks included; its own menus and dialogs open above. */
export const APP_SHELL_FIRST_RUN_LAYER_CLASS = "z-[52]";
export const APP_SHELL_FLOATING_UI_LAYER_INDEX = 55;
export const APP_SHELL_FLOATING_UI_LAYER_CLASS = "z-[55]";
export const APP_SHELL_EDITOR_FLOATING_UI_LAYER_INDEX = 80;
export const APP_SHELL_TOOLTIP_LAYER_INDEX = 90;
export const APP_SHELL_TOOLTIP_LAYER_CLASS = "z-[90]";
export const APP_SHELL_MODAL_LAYER_INDEX = 100;
export const APP_SHELL_MODAL_LAYER_CLASS = "z-[100]";
export const APP_SHELL_TOAST_LAYER_INDEX = 110;
export const APP_SHELL_TOAST_LAYER_CLASS = "z-[110]";
/**
 * A Browser page an Agent drives or captures off-screen keeps painting on a transparent,
 * click-through surface that nothing may occlude.
 */
export const APP_SHELL_BROWSER_PAINT_SURFACE_LAYER_INDEX = 2147483647;
