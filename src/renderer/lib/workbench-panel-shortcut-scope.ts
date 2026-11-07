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

export function isWorkbenchNewChatShortcutTargetEditable(target: EventTarget | null): boolean {
  const element = target as ShortcutTargetLike | null;
  if (!element) return false;
  if (element.isContentEditable) return true;
  if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
    return true;
  }
  if (!element.closest) return false;
  return Boolean(element.closest(".nfm-editor, .bn-editor, .bn-container, [role='dialog']"));
}

export function isFocusedPanelTabShortcutTargetBlocked(target: EventTarget | null): boolean {
  const element = target as ShortcutTargetLike | null;
  if (!element) return false;
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
