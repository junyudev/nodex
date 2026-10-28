import type { CommandId } from "./command-keybindings";

export const TOGGLE_BOTTOM_PANEL_COMMAND_ID = "toggleBottomPanel";
export const TOGGLE_FULL_VIEW_COMMAND_ID = "toggleFullView";
export const CREATE_PAGE_COMMAND_ID = "createPage";
export const CREATE_PAGE_EXPANDED_COMMAND_ID = "createPageExpanded";
export const EXECUTE_WORKBENCH_COMMAND_HOST_CHANNEL = "execute-workbench-command";

export type WorkbenchCommandId = Extract<
  CommandId,
  | typeof TOGGLE_BOTTOM_PANEL_COMMAND_ID
  | typeof TOGGLE_FULL_VIEW_COMMAND_ID
  | typeof CREATE_PAGE_COMMAND_ID
  | typeof CREATE_PAGE_EXPANDED_COMMAND_ID
>;
export type WorkbenchCommandSource = "keyboard_shortcut" | "menu" | "command_palette" | "toolbar";

export interface WorkbenchCommandInvocation {
  commandId: WorkbenchCommandId;
  source: WorkbenchCommandSource;
}

export interface WorkbenchCommandRequest extends WorkbenchCommandInvocation {
  tick: number;
}
