import { useEffect } from "react";
import {
  CREATE_PAGE_COMMAND_ID,
  TOGGLE_BOTTOM_PANEL_COMMAND_ID,
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
  matchKeyboardShortcutSequence,
  matchesKeyboardEventToCommand,
  matchesMouseEventToCommand,
  type CommandId,
  type CommandKeymapState,
  type KeyboardShortcutSequenceState,
  type KeyboardShortcutEventLike,
} from "../../shared/command-keybindings";
import type { CommandMenuOpenRequest } from "./command-palette";
import {
  classifyKeyboardActionSurface,
  keyboardActionHasContext,
  keyboardActionMayRun,
  type KeyboardActionEventLike,
  type KeyboardActionPolicy,
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
  onRequestGoToSettings?: () => void;
  onRequestLatestToastAction?: () => boolean;
  onRequestProcessManager?: () => void;
  onRequestCreatePage?: () => boolean;
  onRequestCreatePageExpanded?: () => boolean;
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

type WorkbenchKeyboardEventLike = KeyboardShortcutEventLike & {
  target: EventTarget | null;
  defaultPrevented?: boolean;
  isComposing?: boolean;
  repeat?: boolean;
  keyCode?: number;
  composedPath?: () => readonly EventTarget[];
};

const APP_COMMAND_POLICY: KeyboardActionPolicy = {
  runWithEditableFocus: true,
  runInsideLocalSurface: true,
  runInsideTerminal: false,
  allowRepeat: false,
};

const CREATE_PAGE_COMMAND_POLICY: KeyboardActionPolicy = {
  runWithEditableFocus: false,
  runInsideLocalSurface: false,
  runInsideTerminal: false,
  allowRepeat: false,
};

function toKeyboardActionEvent(event: WorkbenchKeyboardEventLike): KeyboardActionEventLike {
  return {
    target: event.target,
    defaultPrevented: event.defaultPrevented ?? false,
    isComposing: event.isComposing ?? false,
    repeat: event.repeat ?? false,
    keyCode: event.keyCode ?? 0,
    composedPath: event.composedPath ? () => event.composedPath?.() ?? [] : undefined,
  };
}

function fallbackCommandKeymapState(isMac: boolean): CommandKeymapState {
  return createCommandKeymapState({}, isMac ? "macOS" : "windows");
}

function matchesCommandShortcut(
  e: KeyboardShortcutEventLike,
  actions: WorkbenchShortcutActions,
  commandId: string,
  isMac: boolean,
): boolean {
  return matchesKeyboardEventToCommand(
    e,
    actions.commandKeymapState ?? fallbackCommandKeymapState(isMac),
    commandId,
  );
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
  e: WorkbenchKeyboardEventLike,
  actions: WorkbenchShortcutActions,
  isMac: boolean,
  runtimeState: WorkbenchShortcutRuntimeState = createWorkbenchShortcutRuntimeState(),
): boolean {
  const actionEvent = toKeyboardActionEvent(e);
  if (!keyboardActionMayRun(actionEvent, APP_COMMAND_POLICY)) return false;

  const isBareGesture = !e.metaKey && !e.ctrlKey && !e.altKey;
  if (isBareGesture && !keyboardActionMayRun(actionEvent, CREATE_PAGE_COMMAND_POLICY)) {
    runtimeState.sequence = EMPTY_KEYBOARD_SHORTCUT_SEQUENCE_STATE;
    return false;
  }

  const keymapState = actions.commandKeymapState ?? fallbackCommandKeymapState(isMac);
  const sequence = matchKeyboardShortcutSequence(e, keymapState, runtimeState.sequence, {
    commandAvailable: (commandId) => canExecuteShortcutCommand(commandId, actions),
  });
  runtimeState.sequence = sequence.state;
  if (sequence.kind === "pending") return true;
  if (sequence.kind === "matched") {
    return executeShortcutCommand(sequence.commandId, actions);
  }

  const modifier = isMac ? e.metaKey : e.ctrlKey;
  const targetIsEditable = classifyKeyboardActionSurface(actionEvent) === "editable";
  const targetIsComposerSurface = keyboardActionHasContext(actionEvent, "composer");

  if (matchesCommandShortcut(e, actions, "newWindow", isMac)) {
    actions.onRequestNewWindow?.();
    return true;
  }

  if (matchesCommandShortcut(e, actions, "openCommandMenu", isMac)) {
    actions.onRequestCommandPalette?.({ mode: "root" });
    return true;
  }

  if (matchesCommandShortcut(e, actions, "searchChats", isMac)) {
    actions.onRequestCommandPalette?.({ mode: "chats" });
    return true;
  }

  if (matchesCommandShortcut(e, actions, "searchFiles", isMac)) {
    actions.onRequestCommandPalette?.({ mode: "files" });
    return true;
  }
  if (matchesCommandShortcut(e, actions, "searchPages", isMac)) {
    actions.onRequestCommandPalette?.({ mode: "pages" });
    return true;
  }

  if (matchesCommandShortcut(e, actions, "searchAll", isMac)) {
    actions.onRequestCommandPalette?.({ mode: "root" });
    return Boolean(actions.onRequestCommandPalette);
  }

  if (matchesCommandShortcut(e, actions, CREATE_PAGE_COMMAND_ID, isMac)) {
    if (!keyboardActionMayRun(actionEvent, CREATE_PAGE_COMMAND_POLICY)) return false;
    if (!actions.onRequestCreatePage) return false;
    return actions.onRequestCreatePage();
  }

  if (matchesCommandShortcut(e, actions, "createPageExpanded", isMac)) {
    if (!keyboardActionMayRun(actionEvent, CREATE_PAGE_COMMAND_POLICY)) return false;
    return actions.onRequestCreatePageExpanded?.() ?? false;
  }

  if (matchesCommandShortcut(e, actions, "openModelPicker", isMac)) {
    return executeContextualKeyboardAction("openModelPicker");
  }

  for (const commandId of CONTEXTUAL_COMMAND_IDS) {
    if (commandId === "openModelPicker") continue;
    if (!matchesCommandShortcut(e, actions, commandId, isMac)) continue;
    if (!keyboardActionMayRun(actionEvent, CREATE_PAGE_COMMAND_POLICY)) return false;
    return executeContextualKeyboardAction(commandId);
  }

  if (matchesCommandShortcut(e, actions, "navigateBack", isMac)) {
    actions.navigateBack?.("keyboard_shortcut");
    return true;
  }

  if (matchesCommandShortcut(e, actions, "navigateForward", isMac)) {
    actions.navigateForward?.("keyboard_shortcut");
    return true;
  }

  if (matchesCommandShortcut(e, actions, "toggleSidebar", isMac)) {
    if (targetIsEditable && !targetIsComposerSurface) return false;
    actions.onToggleSidebar?.(
      targetIsComposerSurface ? "composer_sidebar_shortcut" : "keyboard_shortcut",
    );
    return true;
  }

  if (matchesCommandShortcut(e, actions, "renameThread", isMac)) {
    if (!actions.onRequestRenameThread) return false;
    actions.onRequestRenameThread("keyboard_shortcut");
    return true;
  }

  if (matchesCommandShortcut(e, actions, "settings", isMac) && actions.onRequestSettingsToggle) {
    actions.onRequestSettingsToggle();
    return true;
  }

  if (
    matchesCommandShortcut(e, actions, "showKeyboardShortcuts", isMac) &&
    actions.onRequestKeyboardShortcuts
  ) {
    actions.onRequestKeyboardShortcuts();
    return true;
  }

  if (
    matchesCommandShortcut(e, actions, "openProcessManager", isMac) &&
    actions.onRequestProcessManager
  ) {
    actions.onRequestProcessManager();
    return true;
  }

  if (matchesCommandShortcut(e, actions, "openLastToastAction", isMac)) {
    return actions.onRequestLatestToastAction?.() ?? false;
  }

  if (matchesCommandShortcut(e, actions, TOGGLE_BOTTOM_PANEL_COMMAND_ID, isMac)) {
    if (!actions.onRequestWorkbenchCommand) return false;
    actions.onRequestWorkbenchCommand(TOGGLE_BOTTOM_PANEL_COMMAND_ID);
    return true;
  }

  if (matchesCommandShortcut(e, actions, "focusBrowserAddressBar", isMac)) {
    return false;
  }

  if (!modifier) return false;

  if (e.altKey && e.key >= "1" && e.key <= "9") {
    if (targetIsEditable) return false;
    const index = Number.parseInt(e.key, 10) - 1;
    if (index < actions.projectOrder.length) {
      actions.switchToProjectIndex(index);
    }
    return true;
  }

  if (matchesCommandShortcut(e, actions, "findInThread", isMac)) {
    if (!actions.onRequestContentSearch) return false;
    actions.onRequestContentSearch();
    return true;
  }

  return false;
}

export function resolveWorkbenchMouseNavigationShortcut(
  e: Pick<MouseEvent, "button">,
  commandKeymapState?: CommandKeymapState | null,
): "back" | "forward" | null {
  const state = commandKeymapState ?? createCommandKeymapState();
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
    const isMac = navigator.platform.toUpperCase().includes("MAC");
    const runtimeState = createWorkbenchShortcutRuntimeState();

    const onKeyDown = (e: KeyboardEvent) => {
      if (!handleWorkbenchShortcut(e, actions, isMac, runtimeState)) return;
      e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!matchesCommandShortcut(e, actions, "boardPeek", isMac)) return;
      const actionEvent = toKeyboardActionEvent(e);
      if (!keyboardActionMayRun(actionEvent, CREATE_PAGE_COMMAND_POLICY)) return;
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
