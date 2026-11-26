import type { WorkbenchPanelTabCycleDirection } from "../../shared/window-navigation";
import type { WorkbenchPanelTabShortcutItem } from "./workbench-panel-tab-shortcut";
import {
  NEXT_PANEL_TAB_COMMAND_ID,
  PREVIOUS_PANEL_TAB_COMMAND_ID,
  type CommandKeymapState,
} from "../../shared/command-keybindings";
import {
  matchesKeyboardActionCommand,
  type KeyboardActionEventLike,
} from "./keyboard-action-runtime";

export type PanelTabCycleDirection = -1 | 1;

export function resolvePanelTabCycleDirection(
  event: KeyboardActionEventLike,
  keymap: CommandKeymapState,
): PanelTabCycleDirection | null {
  if (matchesKeyboardActionCommand(event, keymap, PREVIOUS_PANEL_TAB_COMMAND_ID)) return -1;
  if (matchesKeyboardActionCommand(event, keymap, NEXT_PANEL_TAB_COMMAND_ID)) return 1;
  return null;
}

export function resolvePanelTabCloseShortcut(
  event: KeyboardActionEventLike,
  keymap: CommandKeymapState,
): boolean {
  return matchesKeyboardActionCommand(event, keymap, "closeTab");
}

export function resolveNextPanelTabId(
  tabs: readonly WorkbenchPanelTabShortcutItem[],
  activeTabId: string | null,
  direction: PanelTabCycleDirection,
): string | null {
  if (tabs.length <= 1) return null;
  if (!activeTabId) return null;

  const currentIndex = tabs.findIndex((tab) => tab.id === activeTabId);
  if (currentIndex < 0) return null;

  const nextIndex = (currentIndex + direction + tabs.length) % tabs.length;
  return tabs[nextIndex]?.id ?? null;
}

export function panelTabCycleRequestDirectionToOffset(
  direction: WorkbenchPanelTabCycleDirection,
): PanelTabCycleDirection {
  return direction === "previous" ? -1 : 1;
}
