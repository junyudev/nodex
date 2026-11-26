import { handleContentSearchNavigationShortcut } from "@/features/content-search/content-search-keyboard";
import { useEffect } from "react";
import { resolveCodexRendererCommandPlatform } from "./codex-window-runtime";
import {
  CAPTURE_TO_INBOX_COMMAND_ID,
  TOGGLE_BOTTOM_PANEL_COMMAND_ID,
  TOGGLE_FULL_VIEW_COMMAND_ID,
  type WorkbenchCommandId,
} from "../../shared/workbench-commands";
import type {
  WorkbenchNavigationCommandSource,
  WorkbenchSidebarToggleCommandSource,
  WorkbenchThreadRenameCommandSource,
} from "../../shared/window-navigation";
import type { ContentSearchDomain } from "@/features/content-search/content-search-context";
import {
  createCommandKeymapState,
  EMPTY_KEYBOARD_SHORTCUT_SEQUENCE_STATE,
  getCommandEntry,
  matchKeyboardShortcutSequence,
  PROJECT_JUMP_SHORTCUT_POLICY,
  matchesKeyboardEventToAccelerator,
  matchesMouseEventToCommand,
  type CommandId,
  type CommandKeymapState,
  type KeyboardShortcutSequenceState,
} from "../../shared/command-keybindings";
import type { CommandMenuOpenRequest } from "./command-palette";
import {
  keyboardActionHasContext,
  keyboardActionMayRun,
  matchesKeyboardActionCommand,
  type KeyboardActionEventLike,
} from "./keyboard-action-runtime";
import {
  canExecuteContextualKeyboardAction,
  executeContextualKeyboardAction,
} from "./contextual-keyboard-actions";

export interface WorkbenchShortcutActions {
  projectOrder: string[];
  switchToProjectIndex: (index: number) => void;
  onRequestNewWindow?: () => void;
  onRequestCommandPalette?: (request?: CommandMenuOpenRequest) => void;
  onRequestContentSearch?: (preferredDomain?: ContentSearchDomain) => void;
  onRequestSettingsToggle?: () => void;
  onRequestKeyboardShortcuts?: () => void;
  onRequestGoToPages?: () => void;
  onRequestGoToInsights?: () => void;
  onRequestGoToSettled?: () => void;
  onRequestGoToSettings?: () => void;
  onRequestLatestToastAction?: () => boolean;
  onRequestInboxCapture?: () => boolean;
  onRequestWorkbenchCommand?: (commandId: WorkbenchCommandId) => void;
  navigateBack?: (source: WorkbenchNavigationCommandSource) => void;
  navigateForward?: (source: WorkbenchNavigationCommandSource) => void;
  onToggleSidebar?: (source: WorkbenchSidebarToggleCommandSource) => void;
  onRequestRenameThread?: (source: WorkbenchThreadRenameCommandSource) => void;
  commandKeymapState?: CommandKeymapState | null;
}

export interface WorkbenchShortcutRuntimeState {
  sequence: KeyboardShortcutSequenceState;
}

export const createWorkbenchShortcutRuntimeState = (): WorkbenchShortcutRuntimeState => ({
  sequence: EMPTY_KEYBOARD_SHORTCUT_SEQUENCE_STATE,
});

export function shouldUseRendererWorkbenchCommandFallback(
  hasNativeWorkbenchCommandIngress: boolean,
): boolean {
  return !hasNativeWorkbenchCommandIngress;
}

function fallbackCommandKeymapState(isMac: boolean): CommandKeymapState {
  const platform = isMac ? "macOS" : resolveCodexRendererCommandPlatform();
  return createCommandKeymapState({}, platform === "macOS" && !isMac ? "windows" : platform);
}

const CONTEXTUAL_COMMAND_IDS = [
  "openModelPicker",
  "workOnPage",
  "boardFocusNext",
  "boardFocusPrevious",
  "boardFocusLeft",
  "boardFocusRight",
  "boardPeek",
  "boardOpen",
  "boardToggleSelection",
  "boardClearSelection",
  "boardSetStatus",
  "boardSetPriority",
  "boardSetEstimate",
  "boardSetTags",
  "boardMoveUp",
  "boardMoveDown",
  "boardMoveTop",
  "boardMoveBottom",
  "boardMoveLeft",
  "boardMoveRight",
] as const satisfies readonly CommandId[];

function canExecuteShortcutCommand(
  commandId: CommandId,
  actions: WorkbenchShortcutActions,
): boolean {
  if (CONTEXTUAL_COMMAND_IDS.includes(commandId as (typeof CONTEXTUAL_COMMAND_IDS)[number])) {
    return canExecuteContextualKeyboardAction(commandId);
  }
  if (commandId === "goToPages") return Boolean(actions.onRequestGoToPages);
  if (commandId === "goToInsights") return Boolean(actions.onRequestGoToInsights);
  if (commandId === "goToSettled") return Boolean(actions.onRequestGoToSettled);
  if (commandId === "goToSettings") return Boolean(actions.onRequestGoToSettings);
  if (commandId === "openPage" || commandId === "openChat") {
    return Boolean(actions.onRequestCommandPalette);
  }
  return true;
}

function executeShortcutCommand(commandId: CommandId, actions: WorkbenchShortcutActions): boolean {
  if (CONTEXTUAL_COMMAND_IDS.includes(commandId as (typeof CONTEXTUAL_COMMAND_IDS)[number])) {
    return executeContextualKeyboardAction(commandId);
  }
  if (commandId === "goToPages" && actions.onRequestGoToPages) {
    actions.onRequestGoToPages();
    return true;
  }
  if (commandId === "goToInsights" && actions.onRequestGoToInsights) {
    actions.onRequestGoToInsights();
    return true;
  }
  if (commandId === "goToSettled" && actions.onRequestGoToSettled) {
    actions.onRequestGoToSettled();
    return true;
  }
  if (commandId === "goToSettings" && actions.onRequestGoToSettings) {
    actions.onRequestGoToSettings();
    return true;
  }
  if (commandId === "openPage" && actions.onRequestCommandPalette) {
    actions.onRequestCommandPalette({ mode: "pages" });
    return true;
  }
  if (commandId === "openChat" && actions.onRequestCommandPalette) {
    actions.onRequestCommandPalette({ mode: "chats" });
    return true;
  }
  return false;
}

export function handleWorkbenchShortcut(
  e: KeyboardActionEventLike,
  actions: WorkbenchShortcutActions,
  isMac: boolean,
  runtimeState: WorkbenchShortcutRuntimeState = createWorkbenchShortcutRuntimeState(),
): boolean {
  const keymap = actions.commandKeymapState ?? fallbackCommandKeymapState(isMac);
  const matches = (commandId: CommandId) => matchesKeyboardActionCommand(e, keymap, commandId);
  if (handleContentSearchNavigationShortcut(e, keymap.platform)) {
    runtimeState.sequence = EMPTY_KEYBOARD_SHORTCUT_SEQUENCE_STATE;
    return true;
  }

  const sequence = matchKeyboardShortcutSequence(e, keymap, runtimeState.sequence, {
    commandAvailable: (commandId) => {
      const entry = getCommandEntry(keymap, commandId);
      return (
        entry !== null &&
        keyboardActionMayRun(e, entry.keyboardActionPolicy, keymap.platform) &&
        canExecuteShortcutCommand(commandId, actions)
      );
    },
  });
  runtimeState.sequence = sequence.state;
  if (sequence.kind === "pending") return true;
  if (sequence.kind === "matched") {
    return executeShortcutCommand(sequence.commandId, actions);
  }

  if (matches("newWindow")) {
    actions.onRequestNewWindow?.();
    return true;
  }

  if (matches("openCommandMenu")) {
    actions.onRequestCommandPalette?.({ mode: "root" });
    return true;
  }

  if (matches("searchChats")) {
    actions.onRequestCommandPalette?.({ mode: "chats" });
    return true;
  }

  if (matches("searchFiles")) {
    actions.onRequestCommandPalette?.({ mode: "files" });
    return true;
  }
  if (matches("searchPages")) {
    actions.onRequestCommandPalette?.({ mode: "pages" });
    return true;
  }

  if (matches("searchAll")) {
    actions.onRequestCommandPalette?.({ mode: "root" });
    return Boolean(actions.onRequestCommandPalette);
  }

  if (matches(CAPTURE_TO_INBOX_COMMAND_ID)) {
    if (!actions.onRequestInboxCapture) return false;
    return actions.onRequestInboxCapture();
  }

  if (matches("openModelPicker")) {
    return executeContextualKeyboardAction("openModelPicker");
  }

  for (const commandId of CONTEXTUAL_COMMAND_IDS) {
    if (commandId === "openModelPicker") continue;
    if (!matches(commandId)) continue;
    return executeContextualKeyboardAction(commandId);
  }

  if (matches("navigateBack")) {
    actions.navigateBack?.("keyboard_shortcut");
    return true;
  }

  if (matches("navigateForward")) {
    actions.navigateForward?.("keyboard_shortcut");
    return true;
  }

  if (matches("toggleSidebar")) {
    const targetIsComposerSurface = keyboardActionHasContext(e, "composer");
    actions.onToggleSidebar?.(
      targetIsComposerSurface ? "composer_sidebar_shortcut" : "keyboard_shortcut",
    );
    return true;
  }

  if (matches("renameThread")) {
    if (!actions.onRequestRenameThread) return false;
    actions.onRequestRenameThread("keyboard_shortcut");
    return true;
  }

  if (matches("settings") && actions.onRequestSettingsToggle) {
    actions.onRequestSettingsToggle();
    return true;
  }

  if (matches("showKeyboardShortcuts") && actions.onRequestKeyboardShortcuts) {
    actions.onRequestKeyboardShortcuts();
    return true;
  }

  if (matches("openLastToastAction")) {
    return actions.onRequestLatestToastAction?.() ?? false;
  }

  for (const commandId of [TOGGLE_BOTTOM_PANEL_COMMAND_ID, TOGGLE_FULL_VIEW_COMMAND_ID] as const) {
    if (!matches(commandId)) continue;
    if (!actions.onRequestWorkbenchCommand) return false;
    actions.onRequestWorkbenchCommand(commandId);
    return true;
  }

  if (matches("findInThread")) {
    if (!actions.onRequestContentSearch) return false;
    actions.onRequestContentSearch();
    return true;
  }

  if (e.altKey && (e.ctrlKey || e.metaKey)) {
    for (let index = 0; index < Math.min(actions.projectOrder.length, 9); index++) {
      if (!matchesKeyboardEventToAccelerator(e, `CmdOrCtrl+Alt+${index + 1}`, keymap.platform)) {
        continue;
      }
      if (!keyboardActionMayRun(e, PROJECT_JUMP_SHORTCUT_POLICY, keymap.platform)) return false;
      actions.switchToProjectIndex(index);
      return true;
    }
  }

  return false;
}

export function resolveWorkbenchMouseNavigationShortcut(
  e: Pick<MouseEvent, "button">,
  commandKeymapState?: CommandKeymapState | null,
): "back" | "forward" | null {
  const state =
    commandKeymapState ?? createCommandKeymapState({}, resolveCodexRendererCommandPlatform());
  if (matchesMouseEventToCommand(e, state, "navigateBack")) return "back";
  if (matchesMouseEventToCommand(e, state, "navigateForward")) return "forward";
  return null;
}

export function handleWorkbenchMouseNavigationShortcut(
  e: Pick<MouseEvent, "button">,
  actions: Pick<
    WorkbenchShortcutActions,
    "navigateBack" | "navigateForward" | "commandKeymapState"
  >,
): boolean {
  const direction = resolveWorkbenchMouseNavigationShortcut(e, actions.commandKeymapState);
  if (direction === "back") {
    if (!actions.navigateBack) return false;
    actions.navigateBack("mouse_back");
    return true;
  }

  if (direction === "forward") {
    if (!actions.navigateForward) return false;
    actions.navigateForward("mouse_forward");
    return true;
  }

  return false;
}

export function useWorkbenchShortcuts(actions: WorkbenchShortcutActions): void {
  useEffect(() => {
    const platform = resolveCodexRendererCommandPlatform();
    const isMac = platform === "macOS";
    const keymap = actions.commandKeymapState ?? createCommandKeymapState({}, platform);
    const resolvedActions = { ...actions, commandKeymapState: keymap };
    const runtimeState = createWorkbenchShortcutRuntimeState();

    const onKeyDown = (e: KeyboardEvent) => {
      if (!handleWorkbenchShortcut(e, resolvedActions, isMac, runtimeState)) return;
      e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!matchesKeyboardActionCommand(e, keymap, "boardPeek")) return;
      if (!executeContextualKeyboardAction("boardPeek", "keyup")) return;
      e.preventDefault();
    };
    const onMouseUp = (e: MouseEvent) => {
      if (!handleWorkbenchMouseNavigationShortcut(e, actions)) return;
      e.preventDefault();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, [actions]);
}
