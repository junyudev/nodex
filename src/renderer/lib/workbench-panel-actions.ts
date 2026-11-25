import { defineMessage, defineMessages, getIntl } from "@/lib/i18n";
import type { ComponentType } from "react";
import {
  createCommandKeymapState,
  formatAcceleratorLabel,
  formatCommandShortcutLabel,
  getCommandEntry,
  getPrimaryCommandAccelerator,
  matchesKeyboardEventToCommand,
  type CommandKeymapState,
} from "../../shared/command-keybindings";
import {
  SidePanelBrowserIcon,
  AerialViewIcon,
  SidePanelFilesIcon,
  SidePanelReviewIcon,
  SidePanelSideChatIcon,
  SidePanelTerminalIcon,
  CanvasIcon,
  BoardIcon,
  NewPageIcon,
  PageIcon,
} from "@/components/shared/icons";
import {
  resolveWorkbenchPanelCapabilities,
  type WorkbenchPanelActionKind,
} from "@/lib/workbench-panel-capabilities";
import type { PanelId, WorkbenchTabKind, WorkbenchTabProjection } from "@/lib/types";

export type PanelNewTabActionKind = WorkbenchPanelActionKind;

export type PanelActionShortcut =
  | "mod+shift+e"
  | "mod+t"
  | "ctrl+shift+g"
  | "ctrl+backquote"
  | "alt+mod+s";

export interface PanelNewTabAction {
  kind: PanelNewTabActionKind;
  defaultPanelId: PanelId;
  targetPanelIds?: readonly PanelId[];
  label: string;
  description: string;
  shortcut?: PanelActionShortcut;
  commandId?: string;
  Icon: ComponentType<{ className?: string }>;
}

/** Project content destinations, presented after the general tools. */
export const NODEX_PANEL_OPTION_ACTION_ORDER: readonly PanelNewTabActionKind[] = [
  "db_view",
  "page_stage",
  "canvas_stage",
];

const NODEX_PANEL_OPTION_ACTION_KIND_SET = new Set<PanelNewTabActionKind>(
  NODEX_PANEL_OPTION_ACTION_ORDER,
);

/** The `agents` surface's name wherever people meet it. */
export const AERIAL_VIEW_TITLE = defineMessage({
  id: "lib.workbenchPanelActions.agents.label",
  defaultMessage: "Aerial view",
});

export const PANEL_TOOL_TITLE_MESSAGES = defineMessages({
  files: { id: "lib.workbenchPanelActions.files.label", defaultMessage: "Files" },
  review: { id: "lib.workbenchPanelActions.review.label", defaultMessage: "Review" },
  terminal: { id: "lib.workbenchPanelActions.terminal.label", defaultMessage: "Terminal" },
  database: { id: "lib.workbenchPanelActions.database.label", defaultMessage: "DB View" },
});

export const PANEL_NEW_TAB_ACTIONS: PanelNewTabAction[] = [
  {
    kind: "agents",
    defaultPanelId: "right",
    targetPanelIds: ["right", "bottom"],
    get label() {
      return getIntl().formatMessage(AERIAL_VIEW_TITLE);
    },
    get description() {
      return getIntl().formatMessage({
        id: "lib.workbenchPanelActions.agents.description",
        defaultMessage: "Every chat at work, with its subagents",
      });
    },
    Icon: AerialViewIcon,
  },
  {
    kind: "files",
    defaultPanelId: "right",
    targetPanelIds: ["right", "bottom"],
    get label() {
      return getIntl().formatMessage(PANEL_TOOL_TITLE_MESSAGES.files);
    },
    get description() {
      return getIntl().formatMessage({
        id: "lib.workbenchPanelActions.files.description",
        defaultMessage: "Browse project files",
      });
    },
    shortcut: "mod+shift+e",
    commandId: "toggleFileTreePanel",
    Icon: SidePanelFilesIcon,
  },
  {
    kind: "side_chat",
    defaultPanelId: "right",
    targetPanelIds: ["right", "bottom"],
    get label() {
      return getIntl().formatMessage({
        id: "lib.workbenchPanelActions.sideChat.label",
        defaultMessage: "Side chat",
      });
    },
    get description() {
      return getIntl().formatMessage({
        id: "lib.workbenchPanelActions.sideChat.description",
        defaultMessage: "Start a side conversation",
      });
    },
    shortcut: "alt+mod+s",
    commandId: "openSideChat",
    Icon: SidePanelSideChatIcon,
  },
  {
    kind: "browser",
    defaultPanelId: "right",
    targetPanelIds: ["right", "bottom"],
    get label() {
      return getIntl().formatMessage({
        id: "lib.workbenchPanelActions.browser.label",
        defaultMessage: "Browser",
      });
    },
    get description() {
      return getIntl().formatMessage({
        id: "lib.workbenchPanelActions.browser.description",
        defaultMessage: "Open a website",
      });
    },
    shortcut: "mod+t",
    commandId: "openBrowserTab",
    Icon: SidePanelBrowserIcon,
  },
  {
    kind: "review",
    defaultPanelId: "right",
    targetPanelIds: ["right"],
    get label() {
      return getIntl().formatMessage(PANEL_TOOL_TITLE_MESSAGES.review);
    },
    get description() {
      return getIntl().formatMessage({
        id: "lib.workbenchPanelActions.review.description",
        defaultMessage: "View code changes",
      });
    },
    shortcut: "ctrl+shift+g",
    commandId: "openReviewTab",
    Icon: SidePanelReviewIcon,
  },
  {
    kind: "terminal",
    defaultPanelId: "bottom",
    targetPanelIds: ["right", "bottom"],
    get label() {
      return getIntl().formatMessage(PANEL_TOOL_TITLE_MESSAGES.terminal);
    },
    get description() {
      return getIntl().formatMessage({
        id: "lib.workbenchPanelActions.terminal.description",
        defaultMessage: "Start an interactive shell",
      });
    },
    shortcut: "ctrl+backquote",
    commandId: "toggleTerminal",
    Icon: SidePanelTerminalIcon,
  },
  {
    kind: "new_page",
    defaultPanelId: "right",
    get label() {
      return getIntl().formatMessage({
        id: "lib.workbenchPanelActions.newPage.label",
        defaultMessage: "New page",
      });
    },
    get description() {
      return getIntl().formatMessage({
        id: "lib.workbenchPanelActions.newPage.description",
        defaultMessage: "Create a Page where this Scene's work lives",
      });
    },
    Icon: NewPageIcon,
  },
  {
    kind: "db_view",
    defaultPanelId: "right",
    get label() {
      return getIntl().formatMessage(PANEL_TOOL_TITLE_MESSAGES.database);
    },
    get description() {
      return getIntl().formatMessage({
        id: "lib.workbenchPanelActions.database.description",
        defaultMessage: "Open the project database",
      });
    },
    Icon: BoardIcon,
  },
  {
    kind: "page_stage",
    defaultPanelId: "right",
    get label() {
      return getIntl().formatMessage({
        id: "lib.workbenchPanelActions.page.label",
        defaultMessage: "Open page",
      });
    },
    get description() {
      return getIntl().formatMessage({
        id: "lib.workbenchPanelActions.page.description",
        defaultMessage: "Open a Project Page",
      });
    },
    Icon: PageIcon,
  },
  {
    kind: "canvas_stage",
    defaultPanelId: "right",
    get label() {
      return getIntl().formatMessage({
        id: "lib.workbenchPanelActions.canvas.label",
        defaultMessage: "Canvas",
      });
    },
    get description() {
      return getIntl().formatMessage({
        id: "lib.workbenchPanelActions.canvas.description",
        defaultMessage: "Open the project Canvas",
      });
    },
    Icon: CanvasIcon,
  },
];

export function getPanelNewTabAction(kind: PanelNewTabActionKind): PanelNewTabAction {
  const action = PANEL_NEW_TAB_ACTIONS.find((candidate) => candidate.kind === kind);
  if (action) return action;
  throw new Error(`Missing panel action presentation for ${kind}`);
}

export function isPanelActionTargetAllowed(action: PanelNewTabAction, panelId: PanelId): boolean {
  return action.targetPanelIds?.includes(panelId) ?? action.defaultPanelId === panelId;
}

export function isWorkbenchTabKind(
  kind: PanelNewTabActionKind,
): kind is Exclude<
  WorkbenchTabProjection["kind"],
  "image_editor" | "page_file" | "skill" | "side_chat" | "plugin_app"
> {
  return kind !== "side_chat" && kind !== "new_page";
}

export function filterAvailablePanelActions(
  actions: readonly PanelNewTabAction[],
  tabs: readonly { readonly kind: WorkbenchTabKind | "conversation" | "inbox" }[],
  panelId: PanelId,
  owner: Parameters<typeof resolveWorkbenchPanelCapabilities>[0]["owner"],
): PanelNewTabAction[] {
  const actionsByKind = new Map(actions.map((action) => [action.kind, action]));
  // An owner's Home (a Session's conversation, a Project's Inbox) is never a new-tab choice.
  const capabilities = resolveWorkbenchPanelCapabilities({
    panelId,
    owner,
    existingTabKinds: tabs.flatMap((tab) =>
      tab.kind === "conversation" || tab.kind === "inbox" ? [] : [tab.kind],
    ),
  });
  return capabilities.availableActionKinds.flatMap((kind) => {
    const action = actionsByKind.get(kind);
    if (!action) return [];
    if (!isPanelActionTargetAllowed(action, panelId)) return [];
    return [action];
  });
}

export function isNodexPanelOptionAction(action: PanelNewTabAction): boolean {
  return NODEX_PANEL_OPTION_ACTION_KIND_SET.has(action.kind);
}

export function isPanelDestinationAction(
  action: PanelNewTabAction,
): action is PanelNewTabAction & { kind: "db_view" | "page_stage" } {
  return action.kind === "db_view" || action.kind === "page_stage";
}

export function resolvePanelShortcutLabel(
  shortcut: PanelActionShortcut | undefined,
  isMac: boolean,
): string | null {
  if (!shortcut) return null;
  if (isMac) return formatAcceleratorLabel(shortcut.replace("mod", "CmdOrCtrl"), "macOS");
  if (shortcut === "mod+shift+e") return "Ctrl+Shift+E";
  if (shortcut === "mod+t") return "Ctrl+T";
  if (shortcut === "ctrl+shift+g") return "⌃⇧G";
  if (shortcut === "alt+mod+s") return "Alt+Ctrl+S";
  return "⌃`";
}

export function resolvePanelActionShortcutLabel(
  action: PanelNewTabAction,
  isMac: boolean,
  commandKeymapState?: CommandKeymapState | null,
): string | null {
  if (action.commandId) {
    const state = commandKeymapState ?? createCommandKeymapState({}, isMac ? "macOS" : "windows");
    const label = formatCommandShortcutLabel(state, action.commandId);
    const entry = getCommandEntry(state, action.commandId);
    if (label && entry?.isCustom !== true && action.shortcut) {
      return resolvePanelShortcutLabel(action.shortcut, isMac);
    }
    if (label) return label;
  }
  return resolvePanelShortcutLabel(action.shortcut, isMac);
}

export function matchesPanelShortcut(
  event: Pick<KeyboardEvent, "altKey" | "code" | "ctrlKey" | "key" | "metaKey" | "shiftKey">,
  shortcut: PanelActionShortcut,
  isMac: boolean,
): boolean {
  const key = event.key.toLowerCase();
  const modifier = isMac ? event.metaKey : event.ctrlKey;
  if (shortcut === "mod+shift+e") {
    return modifier && !event.altKey && event.shiftKey && key === "e";
  }
  if (shortcut === "mod+t") {
    return modifier && !event.altKey && !event.shiftKey && key === "t";
  }
  if (shortcut === "ctrl+shift+g") {
    return event.ctrlKey && !event.metaKey && !event.altKey && event.shiftKey && key === "g";
  }
  if (shortcut === "alt+mod+s") {
    return modifier && event.altKey && !event.shiftKey && key === "s";
  }
  return (
    event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    (event.key === "`" || event.code === "Backquote")
  );
}

export function matchesPanelActionShortcut(
  event: Pick<KeyboardEvent, "altKey" | "code" | "ctrlKey" | "key" | "metaKey" | "shiftKey">,
  action: PanelNewTabAction,
  isMac: boolean,
  commandKeymapState?: CommandKeymapState | null,
): boolean {
  if (action.commandId) {
    const state = commandKeymapState ?? createCommandKeymapState({}, isMac ? "macOS" : "windows");
    if (matchesKeyboardEventToCommand(event, state, action.commandId)) return true;
    // Unassigning the command also releases its default gesture, such as to a focused Terminal.
    if (!getPrimaryCommandAccelerator(state, action.commandId)) return false;
  }
  return action.shortcut ? matchesPanelShortcut(event, action.shortcut, isMac) : false;
}

export function getDefaultPanelIdForTabKind(kind: WorkbenchTabProjection["kind"]): PanelId {
  if (kind === "image_editor" || kind === "page_file" || kind === "skill" || kind === "plugin_app")
    return "right";
  return getPanelNewTabAction(kind).defaultPanelId;
}
