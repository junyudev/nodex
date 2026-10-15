import { describe, expect, test } from "vite-plus/test";
import type { MenuItemConstructorOptions } from "electron";
import type { WorkbenchCommandInvocation } from "../shared/workbench-commands";
import { createCommandKeymapState } from "../shared/command-keybindings";
import {
  buildNodexSetupMenuItems,
  buildWindowFileMenu,
  buildWorkbenchViewMenu,
  INSTALL_CLI_MENU_ITEM_ID,
  SET_UP_AGENT_SKILLS_MENU_ITEM_ID,
  TOGGLE_BOTTOM_PANEL_MENU_ITEM_ID,
} from "./application-menu";

function bottomPanelMenuItem(
  platform: "macOS" | "windows" | "linux",
  overrides: Record<string, string[]> = {},
  onExecuteCommand: (invocation: WorkbenchCommandInvocation) => void = () => undefined,
): MenuItemConstructorOptions {
  const menu = buildWorkbenchViewMenu(
    createCommandKeymapState(overrides, platform),
    onExecuteCommand,
    () => undefined,
  );
  const submenu = menu.submenu as MenuItemConstructorOptions[];
  const item = submenu.find((candidate) => candidate.id === TOGGLE_BOTTOM_PANEL_MENU_ITEM_ID);
  if (!item) throw new Error("Expected the Toggle Bottom Panel menu item");
  return item;
}

function fileMenuItems(
  platform: "macOS" | "windows" | "linux",
  input: {
    overrides?: Record<string, string[]>;
    calls?: string[];
  } = {},
): MenuItemConstructorOptions[] {
  const calls = input.calls ?? [];
  const menu = buildWindowFileMenu({
    commandKeymapState: createCommandKeymapState(input.overrides ?? {}, platform),
    onNewWindow: () => calls.push("new"),
    onCloseWindow: () => calls.push("close"),
  });
  return menu.submenu as MenuItemConstructorOptions[];
}

describe("application menu", () => {
  test("builds independent packaged CLI and Agent Skill setup actions", () => {
    const calls: string[] = [];
    const items = buildNodexSetupMenuItems({
      enabled: true,
      onInstallCli: () => calls.push("cli"),
      onSetupAgentSkills: () => calls.push("skills"),
    });

    expect(items.map((item) => item.id)).toEqual([
      INSTALL_CLI_MENU_ITEM_ID,
      SET_UP_AGENT_SKILLS_MENU_ITEM_ID,
    ]);
    for (const item of items) {
      if (typeof item.click !== "function") throw new Error("Expected menu click");
      item.click({} as never, {} as never, {} as never);
    }
    expect(calls).toEqual(["cli", "skills"]);
  });

  test("disables both setup actions outside a stable packaged App", () => {
    expect(
      buildNodexSetupMenuItems({
        enabled: false,
        onInstallCli: () => undefined,
        onSetupAgentSkills: () => undefined,
      }).every((item) => item.enabled === false),
    ).toBe(true);
  });

  test.each(["macOS", "windows", "linux"] as const)(
    "builds the bottom-panel accelerator on %s",
    (platform) => {
      expect(bottomPanelMenuItem(platform).accelerator).toBe("CommandOrControl+J");
    },
  );

  test("uses the custom primary accelerator and preserves explicit unassignment", () => {
    expect(
      bottomPanelMenuItem("macOS", {
        toggleBottomPanel: ["CmdOrCtrl+Alt+J"],
      }).accelerator,
    ).toBe("CommandOrControl+Alt+J");
    expect(
      bottomPanelMenuItem("macOS", {
        toggleBottomPanel: [],
      }).accelerator,
    ).toBeUndefined();
  });

  test("dispatches the typed workbench command once", () => {
    const invocations: unknown[] = [];
    const item = bottomPanelMenuItem("macOS", {}, (invocation) => {
      invocations.push(invocation);
    });

    if (typeof item.click !== "function") throw new Error("Expected a menu click handler");
    item.click({} as never, {} as never, {} as never);

    expect(invocations).toEqual([
      {
        commandId: "toggleBottomPanel",
        source: "menu",
      },
    ]);
  });

  test.each(["macOS", "windows", "linux"] as const)(
    "builds configurable window commands on %s",
    (platform) => {
      const items = fileMenuItems(platform);

      expect(items.flatMap((item) => item.id ?? [])).toEqual([
        "file.newWindow",
        "file.closeWindow",
      ]);
      expect(items.find((item) => item.id === "file.newWindow")?.accelerator).toBe(
        "CommandOrControl+Shift+N",
      );
      expect(items.find((item) => item.id === "file.closeWindow")?.accelerator).toBe(
        "CommandOrControl+Shift+W",
      );
    },
  );

  test("dispatches each file action once", () => {
    const calls: string[] = [];
    const items = fileMenuItems("macOS", { calls });
    const actionable = items.filter((item) => typeof item.click === "function");

    for (const item of actionable) {
      if (typeof item.click !== "function") continue;
      item.click({} as never, {} as never, {} as never);
    }
    expect(calls).toEqual(["new", "close"]);
  });
});
