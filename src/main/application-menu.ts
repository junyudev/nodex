import type { MenuItemConstructorOptions } from "electron";
import type { SurfaceHistoryDirection } from "../shared/surface-history";
import {
  getPrimaryCommandAccelerator,
  toElectronAccelerator,
  type CommandKeymapState,
} from "../shared/command-keybindings";
import {
  TOGGLE_BOTTOM_PANEL_COMMAND_ID,
  type WorkbenchCommandInvocation,
} from "../shared/workbench-commands";

export const TOGGLE_BOTTOM_PANEL_MENU_ITEM_ID = "view.toggleBottomPanel";
export const INSTALL_CLI_MENU_ITEM_ID = "app.installCli";
export const SET_UP_AGENT_SKILLS_MENU_ITEM_ID = "app.setupAgentSkills";

/** History is application-owned; the other edit actions retain their native roles. */
export function buildWindowEditMenu(
  platform: NodeJS.Platform,
  execute: (direction: SurfaceHistoryDirection) => void,
): MenuItemConstructorOptions {
  return {
    role: "editMenu",
    submenu: [
      {
        id: "edit.undo",
        label: "Undo",
        accelerator: "CommandOrControl+Z",
        click: () => execute("undo"),
      },
      {
        id: "edit.redo",
        label: "Redo",
        accelerator: platform === "darwin" ? "CommandOrControl+Shift+Z" : "Control+Y",
        click: () => execute("redo"),
      },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "pasteAndMatchStyle" },
      { role: "delete" },
      { type: "separator" },
      { role: "selectAll" },
      ...(platform === "darwin"
        ? ([
            { type: "separator" },
            { label: "Speech", submenu: [{ role: "startSpeaking" }, { role: "stopSpeaking" }] },
          ] satisfies MenuItemConstructorOptions[])
        : []),
    ],
  };
}

interface NodexSetupMenuOptions {
  enabled: boolean;
  onInstallCli: () => void;
  onSetupAgentSkills: () => void;
}

export function buildNodexSetupMenuItems(
  options: NodexSetupMenuOptions,
): MenuItemConstructorOptions[] {
  return [
    {
      id: INSTALL_CLI_MENU_ITEM_ID,
      label: "Install Command Line Tool…",
      enabled: options.enabled,
      click: options.onInstallCli,
    },
    {
      id: SET_UP_AGENT_SKILLS_MENU_ITEM_ID,
      label: "Set Up Agent Skills…",
      enabled: options.enabled,
      click: options.onSetupAgentSkills,
    },
  ];
}

interface WindowFileMenuOptions {
  commandKeymapState: CommandKeymapState;
  onNewWindow: () => void;
  onCloseWindow: () => void;
}

export function buildWindowFileMenu(options: WindowFileMenuOptions): MenuItemConstructorOptions {
  const accelerator = (commandId: string): string | undefined =>
    toElectronAccelerator(getPrimaryCommandAccelerator(options.commandKeymapState, commandId));

  return {
    label: "File",
    submenu: [
      {
        id: "file.newWindow",
        label: "New Window",
        accelerator: accelerator("newWindow"),
        click: options.onNewWindow,
      },
      { type: "separator" },
      {
        id: "file.closeWindow",
        label: "Close Window",
        accelerator: accelerator("closeWindow"),
        click: options.onCloseWindow,
      },
    ],
  };
}

export function buildWorkbenchViewMenu(
  commandKeymapState: CommandKeymapState,
  onExecuteCommand: (invocation: WorkbenchCommandInvocation) => void,
): MenuItemConstructorOptions {
  return {
    label: "View",
    submenu: [
      {
        id: TOGGLE_BOTTOM_PANEL_MENU_ITEM_ID,
        label: "Toggle Bottom Panel",
        accelerator: toElectronAccelerator(
          getPrimaryCommandAccelerator(commandKeymapState, TOGGLE_BOTTOM_PANEL_COMMAND_ID),
        ),
        click: () => {
          onExecuteCommand({
            commandId: TOGGLE_BOTTOM_PANEL_COMMAND_ID,
            source: "menu",
          });
        },
      },
      { type: "separator" },
      { role: "reload" },
      { role: "forceReload" },
      { role: "toggleDevTools" },
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  };
}
