import type { MenuItemConstructorOptions } from "electron";
import type { SurfaceHistoryDirection } from "../shared/surface-history";
import {
  getPrimaryCommandAccelerator,
  toElectronAccelerator,
  type CommandKeymapState,
} from "../shared/command-keybindings";
import {
  TOGGLE_BOTTOM_PANEL_COMMAND_ID,
  TOGGLE_FULL_VIEW_COMMAND_ID,
  type WorkbenchCommandInvocation,
} from "../shared/workbench-commands";
import type { WindowZoomCommand } from "./window-navigation-chrome";
import { getMainIntl, defineMessages } from "./i18n/main-intl";

export const NEW_WINDOW_MENU_ITEM_ID = "file.newWindow";
export const TOGGLE_BOTTOM_PANEL_MENU_ITEM_ID = "view.toggleBottomPanel";
export const TOGGLE_FULL_VIEW_MENU_ITEM_ID = "view.toggleFullView";
export const INSTALL_CLI_MENU_ITEM_ID = "app.installCli";
export const SET_UP_AGENT_SKILLS_MENU_ITEM_ID = "app.setupAgentSkills";

const historyMessages = defineMessages({
  undo: { id: "main.appMenu.edit.undo", defaultMessage: "Undo" },
  redo: { id: "main.appMenu.edit.redo", defaultMessage: "Redo" },
});

export function windowHistoryMenuLabel(
  direction: SurfaceHistoryDirection,
  action?: string | null,
): string {
  const intl = getMainIntl();
  if (!action) return intl.formatMessage(historyMessages[direction]);
  return direction === "undo"
    ? intl.formatMessage(
        { id: "main.appMenu.edit.undoAction", defaultMessage: "Undo {action}" },
        { action },
      )
    : intl.formatMessage(
        { id: "main.appMenu.edit.redoAction", defaultMessage: "Redo {action}" },
        { action },
      );
}

export const newWindowMenuLabel = (): string =>
  getMainIntl().formatMessage({ id: "main.appMenu.file.newWindow", defaultMessage: "New Window" });

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
        label: windowHistoryMenuLabel("undo"),
        accelerator: "CommandOrControl+Z",
        click: () => execute("undo"),
      },
      {
        id: "edit.redo",
        label: windowHistoryMenuLabel("redo"),
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
            {
              label: getMainIntl().formatMessage({
                id: "main.appMenu.edit.speech",
                defaultMessage: "Speech",
              }),
              submenu: [{ role: "startSpeaking" }, { role: "stopSpeaking" }],
            },
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
      label: getMainIntl().formatMessage({
        id: "main.appMenu.setup.installCli",
        defaultMessage: "Install Command Line Tool…",
      }),
      enabled: options.enabled,
      click: options.onInstallCli,
    },
    {
      id: SET_UP_AGENT_SKILLS_MENU_ITEM_ID,
      label: getMainIntl().formatMessage({
        id: "main.appMenu.setup.agentSkills",
        defaultMessage: "Set Up Agent Skills…",
      }),
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
    id: "menu.file",
    label: getMainIntl().formatMessage({ id: "main.appMenu.file.title", defaultMessage: "File" }),
    submenu: [
      {
        id: NEW_WINDOW_MENU_ITEM_ID,
        label: newWindowMenuLabel(),
        accelerator: accelerator("newWindow"),
        click: options.onNewWindow,
      },
      { type: "separator" },
      {
        id: "file.closeWindow",
        label: getMainIntl().formatMessage({
          id: "main.appMenu.file.closeWindow",
          defaultMessage: "Close Window",
        }),
        accelerator: accelerator("closeWindow"),
        click: options.onCloseWindow,
      },
    ],
  };
}

export function buildWorkbenchViewMenu(
  commandKeymapState: CommandKeymapState,
  onExecuteCommand: (invocation: WorkbenchCommandInvocation) => void,
  onZoom: (command: WindowZoomCommand) => void,
): MenuItemConstructorOptions {
  const isWindows = commandKeymapState.platform === "windows";
  return {
    id: "menu.view",
    label: getMainIntl().formatMessage({ id: "main.appMenu.view.title", defaultMessage: "View" }),
    submenu: [
      {
        id: TOGGLE_BOTTOM_PANEL_MENU_ITEM_ID,
        label: getMainIntl().formatMessage({
          id: "main.appMenu.view.toggleBottomPanel",
          defaultMessage: "Toggle Bottom Panel",
        }),
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
      {
        id: TOGGLE_FULL_VIEW_MENU_ITEM_ID,
        label: getMainIntl().formatMessage({
          id: "main.appMenu.view.toggleFullView",
          defaultMessage: "Toggle Full View",
        }),
        accelerator: toElectronAccelerator(
          getPrimaryCommandAccelerator(commandKeymapState, TOGGLE_FULL_VIEW_COMMAND_ID),
        ),
        click: () => {
          onExecuteCommand({
            commandId: TOGGLE_FULL_VIEW_COMMAND_ID,
            source: "menu",
          });
        },
      },
      { type: "separator" },
      { role: "reload", ...(isWindows ? { accelerator: "Ctrl+R" } : {}) },
      { role: "forceReload", ...(isWindows ? { accelerator: "Ctrl+Shift+R" } : {}) },
      { role: "toggleDevTools", ...(isWindows ? { accelerator: "Ctrl+Shift+I" } : {}) },
      { type: "separator" },
      {
        id: "view.resetZoom",
        label: getMainIntl().formatMessage({
          id: "main.appMenu.view.actualSize",
          defaultMessage: "Actual Size",
        }),
        accelerator: "CommandOrControl+0",
        click: () => onZoom("reset"),
      },
      {
        id: "view.zoomIn",
        label: getMainIntl().formatMessage({
          id: "main.appMenu.view.zoomIn",
          defaultMessage: "Zoom In",
        }),
        accelerator: "CommandOrControl+Plus",
        click: () => onZoom("in"),
      },
      {
        id: "view.zoomOut",
        label: getMainIntl().formatMessage({
          id: "main.appMenu.view.zoomOut",
          defaultMessage: "Zoom Out",
        }),
        accelerator: "CommandOrControl+-",
        click: () => onZoom("out"),
      },
      { type: "separator" },
      { role: "togglefullscreen", ...(isWindows ? { accelerator: "F11" } : {}) },
    ],
  };
}
