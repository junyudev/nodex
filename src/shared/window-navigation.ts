export const NAVIGATE_BACK_COMMAND_ID = "navigateBack";
export const NAVIGATE_FORWARD_COMMAND_ID = "navigateForward";
export const TOGGLE_SIDEBAR_COMMAND_ID = "toggleSidebar";
export const RENAME_THREAD_COMMAND_ID = "renameThread";
export const OPEN_CONTENT_SEARCH_COMMAND_ID = "findInThread";

export const NAVIGATE_BACK_HOST_CHANNEL = "navigate-back";
export const NAVIGATE_FORWARD_HOST_CHANNEL = "navigate-forward";
export const TOGGLE_SIDEBAR_HOST_CHANNEL = "toggle-sidebar";
export const RENAME_THREAD_HOST_CHANNEL = "rename-thread";
export const OPEN_CONTENT_SEARCH_HOST_CHANNEL = "open-content-search";
export const CYCLE_PANEL_TAB_PREVIOUS_HOST_CHANNEL = "cycle-panel-tab-previous";
export const CYCLE_PANEL_TAB_NEXT_HOST_CHANNEL = "cycle-panel-tab-next";
export const CLOSE_PANEL_TAB_HOST_CHANNEL = "close-panel-tab";
export const REQUEST_NEW_WINDOW_HOST_CHANNEL = "request-new-window";

export type WorkbenchNavigationCommandId =
  | typeof NAVIGATE_BACK_COMMAND_ID
  | typeof NAVIGATE_FORWARD_COMMAND_ID;

export type WorkbenchNavigationHostChannel =
  | typeof NAVIGATE_BACK_HOST_CHANNEL
  | typeof NAVIGATE_FORWARD_HOST_CHANNEL;

export type WorkbenchSidebarToggleCommandId = typeof TOGGLE_SIDEBAR_COMMAND_ID;
export type WorkbenchSidebarToggleHostChannel = typeof TOGGLE_SIDEBAR_HOST_CHANNEL;
export type WorkbenchThreadRenameCommandId = typeof RENAME_THREAD_COMMAND_ID;
export type WorkbenchThreadRenameHostChannel = typeof RENAME_THREAD_HOST_CHANNEL;
export type WorkbenchContentSearchCommandId = typeof OPEN_CONTENT_SEARCH_COMMAND_ID;
export type WorkbenchContentSearchHostChannel = typeof OPEN_CONTENT_SEARCH_HOST_CHANNEL;
export type WorkbenchPanelTabCycleHostChannel =
  | typeof CYCLE_PANEL_TAB_PREVIOUS_HOST_CHANNEL
  | typeof CYCLE_PANEL_TAB_NEXT_HOST_CHANNEL;
export type WorkbenchPanelTabCloseHostChannel = typeof CLOSE_PANEL_TAB_HOST_CHANNEL;

export type WorkbenchNavigationCommandSource =
  | "sidebar_back"
  | "sidebar_forward"
  | "keyboard_shortcut"
  | "mouse_back"
  | "mouse_forward"
  | "menu"
  | "command_palette";

export type WorkbenchNavigationDirection = "back" | "forward";

export interface WorkbenchNavigationCommandState {
  canNavigateBack: boolean;
  canNavigateForward: boolean;
}

export type WorkbenchPanelTabCycleDirection = "previous" | "next";

export type WorkbenchThreadRenameCommandSource = "keyboard_shortcut" | "menu" | "command_palette";

export type WorkbenchSidebarToggleCommandSource =
  | "sidebar_trigger"
  | "composer_sidebar_shortcut"
  | "keyboard_shortcut"
  | "menu"
  | "command_palette";

export interface WorkbenchNavigationCommandDefinition {
  id: WorkbenchNavigationCommandId;
  label: "Back" | "Forward";
  hostChannel: WorkbenchNavigationHostChannel;
  accelerator: "CmdOrCtrl+[" | "CmdOrCtrl+]";
  mouseBinding: "MouseBack" | "MouseForward";
}

export interface WorkbenchSidebarToggleCommandDefinition {
  id: WorkbenchSidebarToggleCommandId;
  label: "Toggle sidebar";
  hostChannel: WorkbenchSidebarToggleHostChannel;
  accelerator: "CmdOrCtrl+B";
}

export interface WorkbenchThreadRenameCommandDefinition {
  id: WorkbenchThreadRenameCommandId;
  label: "Rename chat";
  hostChannel: WorkbenchThreadRenameHostChannel;
  accelerator: "CmdOrCtrl+Alt+R";
}

export interface WorkbenchContentSearchCommandDefinition {
  id: WorkbenchContentSearchCommandId;
  label: "Find";
  hostChannel: WorkbenchContentSearchHostChannel;
  accelerator: "CmdOrCtrl+F";
}

export const WORKBENCH_NAVIGATION_COMMANDS: {
  back: WorkbenchNavigationCommandDefinition;
  forward: WorkbenchNavigationCommandDefinition;
} = {
  back: {
    id: NAVIGATE_BACK_COMMAND_ID,
    label: "Back",
    hostChannel: NAVIGATE_BACK_HOST_CHANNEL,
    accelerator: "CmdOrCtrl+[",
    mouseBinding: "MouseBack",
  },
  forward: {
    id: NAVIGATE_FORWARD_COMMAND_ID,
    label: "Forward",
    hostChannel: NAVIGATE_FORWARD_HOST_CHANNEL,
    accelerator: "CmdOrCtrl+]",
    mouseBinding: "MouseForward",
  },
};

export const WORKBENCH_SIDEBAR_TOGGLE_COMMAND: WorkbenchSidebarToggleCommandDefinition = {
  id: TOGGLE_SIDEBAR_COMMAND_ID,
  label: "Toggle sidebar",
  hostChannel: TOGGLE_SIDEBAR_HOST_CHANNEL,
  accelerator: "CmdOrCtrl+B",
};

export const WORKBENCH_THREAD_RENAME_COMMAND: WorkbenchThreadRenameCommandDefinition = {
  id: RENAME_THREAD_COMMAND_ID,
  label: "Rename chat",
  hostChannel: RENAME_THREAD_HOST_CHANNEL,
  accelerator: "CmdOrCtrl+Alt+R",
};

export const WORKBENCH_CONTENT_SEARCH_COMMAND: WorkbenchContentSearchCommandDefinition = {
  id: OPEN_CONTENT_SEARCH_COMMAND_ID,
  label: "Find",
  hostChannel: OPEN_CONTENT_SEARCH_HOST_CHANNEL,
  accelerator: "CmdOrCtrl+F",
};

export function resolveWorkbenchNavigationShortcutLabel(
  direction: "back" | "forward",
  isMac: boolean,
): string {
  const suffix = direction === "back" ? "[" : "]";
  return isMac ? `⌘${suffix}` : `Ctrl+${suffix}`;
}
