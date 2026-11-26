import { describe, expect, test } from "vite-plus/test";
import type { MenuItemConstructorOptions, Menu, MenuItem } from "electron";
import type { WorkbenchCommandInvocation } from "../shared/workbench-commands";
import { createCommandKeymapState } from "../shared/command-keybindings";
import {
  buildNodexSetupMenuItems,
  buildWindowFileMenu,
  buildWorkbenchViewMenu,
  INSTALL_CLI_MENU_ITEM_ID,
  SET_UP_AGENT_SKILLS_MENU_ITEM_ID,
  TOGGLE_BOTTOM_PANEL_MENU_ITEM_ID,
  TOGGLE_FULL_VIEW_MENU_ITEM_ID,
} from "./application-menu";
import {
  ApplicationMenuSnapshots,
  findNativeMenuAccelerator,
  matchesNativeMenuAccelerator,
} from "./application-menu-snapshot";

describe("application-menu", () => {
  function workbenchMenuItem(
    menuItemId: string,
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
    const item = submenu.find((candidate) => candidate.id === menuItemId);
    if (!item) throw new Error(`Expected the ${menuItemId} menu item`);
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
        expect(workbenchMenuItem(TOGGLE_BOTTOM_PANEL_MENU_ITEM_ID, platform).accelerator).toBe(
          "CommandOrControl+J",
        );
      },
    );

    test("uses the custom primary accelerator and preserves explicit unassignment", () => {
      expect(
        workbenchMenuItem(TOGGLE_BOTTOM_PANEL_MENU_ITEM_ID, "macOS", {
          toggleBottomPanel: ["CmdOrCtrl+Alt+J"],
        }).accelerator,
      ).toBe("CommandOrControl+Alt+J");
      expect(
        workbenchMenuItem(TOGGLE_BOTTOM_PANEL_MENU_ITEM_ID, "macOS", {
          toggleBottomPanel: [],
        }).accelerator,
      ).toBeUndefined();
    });

    test("dispatches the typed workbench command once", () => {
      const invocations: unknown[] = [];
      const item = workbenchMenuItem(
        TOGGLE_BOTTOM_PANEL_MENU_ITEM_ID,
        "macOS",
        {},
        (invocation) => {
          invocations.push(invocation);
        },
      );

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
      "builds a configurable full-view accelerator on %s",
      (platform) => {
        expect(workbenchMenuItem(TOGGLE_FULL_VIEW_MENU_ITEM_ID, platform).accelerator).toBe(
          "CommandOrControl+Shift+F",
        );
        expect(
          workbenchMenuItem(TOGGLE_FULL_VIEW_MENU_ITEM_ID, platform, {
            toggleFullView: ["CmdOrCtrl+Alt+F"],
          }).accelerator,
        ).toBe("CommandOrControl+Alt+F");
        expect(
          workbenchMenuItem(TOGGLE_FULL_VIEW_MENU_ITEM_ID, platform, { toggleFullView: [] })
            .accelerator,
        ).toBeUndefined();
      },
    );

    test("places full view next to the bottom panel and dispatches it once", () => {
      const invocations: WorkbenchCommandInvocation[] = [];
      const menu = buildWorkbenchViewMenu(
        createCommandKeymapState({}, "macOS"),
        (invocation) => invocations.push(invocation),
        () => undefined,
      );
      const items = menu.submenu as MenuItemConstructorOptions[];
      const bottomIndex = items.findIndex((item) => item.id === TOGGLE_BOTTOM_PANEL_MENU_ITEM_ID);
      const item = items[bottomIndex + 1];
      expect(item?.id).toBe(TOGGLE_FULL_VIEW_MENU_ITEM_ID);
      expect(item?.label).toBe("Toggle Full View");
      if (typeof item?.click !== "function") throw new Error("Expected a menu click handler");
      item.click({} as never, {} as never, {} as never);
      expect(invocations).toEqual([{ commandId: "toggleFullView", source: "menu" }]);
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
});

describe("application-menu-snapshot", () => {
  function fixture() {
    const action = { label: "Copy", type: "normal", enabled: true, visible: true } as MenuItem;
    const parent = {
      label: "&Edit",
      type: "submenu",
      enabled: true,
      visible: true,
      submenu: { items: [action] },
    } as MenuItem;
    const menu = { items: [parent] } as Menu;
    return { action, parent, menu };
  }
  test("snapshot membership belongs to one window and is revoked on reread, rebuild, and release", () => {
    const snapshots = new ApplicationMenuSnapshots();
    const { action, menu } = fixture();
    const first = snapshots.read(1, menu).menus[0]!.items[0]!.id;
    expect(snapshots.resolve(1, first)).toBe(action);
    expect(snapshots.resolve(2, first)).toBeNull();
    snapshots.read(1, menu);
    expect(snapshots.resolve(1, first)).toBeNull();
    const second = snapshots.read(2, menu).menus[0]!.items[0]!.id;
    snapshots.release(2);
    expect(snapshots.resolve(2, second)).toBeNull();
    const third = snapshots.read(1, menu).menus[0]!.items[0]!.id;
    snapshots.clear();
    expect(snapshots.resolve(1, third)).toBeNull();
  });
  test("invocation revalidates visible and enabled ancestry and excludes structural rows", () => {
    const snapshots = new ApplicationMenuSnapshots();
    const { action, parent, menu } = fixture();
    const snapshot = snapshots.read(1, menu);
    const id = snapshot.menus[0]!.items[0]!.id;
    expect(snapshot.menus[0]!.label).toBe("Edit");
    expect(snapshots.resolve(1, snapshot.menus[0]!.id)).toBeNull();
    parent.enabled = false;
    expect(snapshots.resolve(1, id)).toBeNull();
    parent.enabled = true;
    action.visible = false;
    expect(snapshots.resolve(1, id)).toBeNull();
    expect(snapshots.read(1, menu).menus[0]!.items).toEqual([]);
  });

  test("only Main-owned enabled accelerators cross native input after menu removal", () => {
    const { menu, parent } = fixture();
    const reload = {
      label: "Reload",
      role: "reload",
      enabled: true,
      visible: true,
      accelerator: "Ctrl+R",
    } as MenuItem;
    const workspaceAction = {
      label: "New Chat",
      id: "file.newThread",
      enabled: true,
      visible: true,
      accelerator: "Ctrl+N",
    } as MenuItem;
    const menuOwnedActions = [
      ["file.newWindow", "Ctrl+Shift+N"],
      ["view.toggleFullView", "Ctrl+Shift+F"],
      ["view.toggleBottomPanel", "Ctrl+J"],
    ].map(([id, accelerator]) => ({ id, enabled: true, visible: true, accelerator }) as MenuItem);
    const closeWindow = {
      label: "Close Window",
      id: "file.closeWindow",
      enabled: true,
      visible: true,
      accelerator: "Ctrl+Shift+W",
    } as MenuItem;
    parent.submenu!.items.push(reload, workspaceAction, closeWindow, ...menuOwnedActions);
    expect(findNativeMenuAccelerator(menu, (key) => key === "Ctrl+R")).toBe(reload);
    expect(findNativeMenuAccelerator(menu, (key) => key === "Ctrl+N")).toBeNull();
    expect(findNativeMenuAccelerator(menu, (key) => key === "Ctrl+Shift+W")).toBe(closeWindow);
    for (const item of menuOwnedActions) {
      expect(findNativeMenuAccelerator(menu, (key) => key === item.accelerator)).toBe(item);
    }
    parent.enabled = false;
    expect(findNativeMenuAccelerator(menu, () => true)).toBeNull();
  });

  test("native Zoom In accepts shifted equals and numeric plus without claiming other keys", () => {
    const event = {
      key: "+",
      code: "Equal",
      ctrlKey: true,
      altKey: false,
      metaKey: false,
      shiftKey: true,
    };
    expect(matchesNativeMenuAccelerator(event, "CommandOrControl+Plus")).toBe(true);
    expect(
      matchesNativeMenuAccelerator(
        { ...event, code: "NumpadAdd", shiftKey: false },
        "CommandOrControl+Plus",
      ),
    ).toBe(true);
    expect(
      matchesNativeMenuAccelerator(
        { ...event, key: "=", shiftKey: false },
        "CommandOrControl+Plus",
      ),
    ).toBe(false);
    expect(
      matchesNativeMenuAccelerator({ ...event, ctrlKey: false }, "CommandOrControl+Plus"),
    ).toBe(false);
  });
});
