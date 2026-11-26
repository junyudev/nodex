import type { PanelId } from "@/lib/types";

const PANEL_FOCUS_AREA_SELECTOR =
  '[data-app-shell-focus-area="right-panel"], [data-app-shell-focus-area="bottom-panel"]';
const PANEL_GROUP_LEAF_SELECTOR = "[data-panel-group-leaf-id]";

interface ShortcutTargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => Element | null;
}

export interface PanelTabCycleScope {
  panelId: PanelId;
  leafId: string;
}

export function isCodexTerminalShortcutTarget(target: EventTarget | null): boolean {
  const element = target as ShortcutTargetLike | null;
  if (!element?.closest) return false;
  return Boolean(element.closest("[data-codex-terminal]"));
}

export function isDialogShortcutTarget(target: EventTarget | null): boolean {
  const element = target as ShortcutTargetLike | null;
  return Boolean(element?.closest?.("[role='dialog']"));
}

/** New chat works while typing, as a native menu item would; dialogs and Terminals keep their keys. */
export function isNewChatShortcutTargetBlocked(target: EventTarget | null): boolean {
  return isDialogShortcutTarget(target) || isCodexTerminalShortcutTarget(target);
}

export function isWorkbenchShortcutTargetEditable(target: EventTarget | null): boolean {
  const element = target as ShortcutTargetLike | null;
  if (!element) return false;
  if (element.isContentEditable) return true;
  if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
    return true;
  }
  if (!element.closest) return false;
  return Boolean(element.closest(".nfm-editor, .bn-editor, .bn-container, [role='dialog']"));
}

/** Marks a field, such as a Browser address bar, where tab shortcuts still close and switch tabs. */
const PANEL_TAB_SHORTCUTS_PASS_THROUGH_SELECTOR = "[data-panel-tab-shortcuts-pass-through]";

export function isFocusedPanelTabShortcutTargetBlocked(target: EventTarget | null): boolean {
  const element = target as ShortcutTargetLike | null;
  if (!element) return false;
  if (element.closest?.(PANEL_TAB_SHORTCUTS_PASS_THROUGH_SELECTOR)) return false;
  if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
    return true;
  }
  if (!element.closest) return Boolean(element.isContentEditable);
  if (element.closest("[role='dialog']")) return true;
  if (element.closest(".nfm-editor")) return false;
  return Boolean(element.isContentEditable || element.closest(".bn-editor, .bn-container"));
}

export function isWorkbenchPanelTabShortcutTargetBlocked(target: EventTarget | null): boolean {
  return isCodexTerminalShortcutTarget(target) || isFocusedPanelTabShortcutTargetBlocked(target);
}

export function resolveFocusedPanelTabCycleScope(
  target: EventTarget | null,
): PanelTabCycleScope | null {
  const element = target as ShortcutTargetLike | null;
  if (!element?.closest) return null;

  const focusArea = element.closest(PANEL_FOCUS_AREA_SELECTOR);
  const focusAreaId = focusArea?.getAttribute("data-app-shell-focus-area");
  const panelId =
    focusAreaId === "right-panel" ? "right" : focusAreaId === "bottom-panel" ? "bottom" : null;
  if (!panelId) return null;

  const leafId =
    element.closest(PANEL_GROUP_LEAF_SELECTOR)?.getAttribute("data-panel-group-leaf-id") ?? null;
  if (!leafId) return null;
  return { panelId, leafId };
}

export function isDocumentLevelShortcutTarget(target: EventTarget | null): boolean {
  if (typeof document === "undefined") return false;
  return target === document || target === document.body || target === document.documentElement;
}
