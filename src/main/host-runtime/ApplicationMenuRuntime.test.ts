import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { assert, it } from "@effect/vitest";
import type { BrowserWindow, Menu, MenuItemConstructorOptions } from "electron";
import { createCommandKeymapState } from "../../shared/command-keybindings";
import { layer as scopedCallbackRuntimeLive } from "../app/ScopedCallbackRuntime";
import type { WindowRuntimeService } from "../window-runtime/WindowRuntime";
import {
  ApplicationMenuRuntime,
  type ApplicationMenuNativePort,
  live,
} from "./ApplicationMenuRuntime";

it.effect("owns native menus and refreshes commands without replacing the runtime", () =>
  Effect.gen(function* () {
    const templates: MenuItemConstructorOptions[][] = [];
    const applicationMenus: Array<Menu | null> = [];
    const dockMenus: Array<Menu | null> = [];
    const sent: Array<{ channel: string; args: unknown[] }> = [];
    let newWindowCount = 0;
    let closeCount = 0;
    let focused: ReturnType<ApplicationMenuNativePort["getFocusedWebContents"]> = null;
    let notifyFocus = () => {};
    const window = {
      close: () => {
        closeCount += 1;
      },
      isDestroyed: () => false,
      webContents: {
        id: 1,
        isDestroyed: () => false,
        send: (channel: string, ...args: unknown[]) => sent.push({ channel, args }),
      },
    } as unknown as BrowserWindow;
    const windows = {
      getLastFocused: () => window,
      events: Stream.never,
    } as unknown as WindowRuntimeService;
    const native: ApplicationMenuNativePort = {
      getFocusedWebContents: () => focused,
      buildFromTemplate: (template) => {
        templates.push(template);
        const findItem = (
          items: MenuItemConstructorOptions[],
          id: string,
        ): MenuItemConstructorOptions | undefined => {
          for (const item of items) {
            if (item.id === id) return item;
            if (!Array.isArray(item.submenu)) continue;
            const found = findItem(item.submenu, id);
            if (found) return found;
          }
          return undefined;
        };
        return {
          template,
          getMenuItemById: (id: string) => findItem(template, id),
        } as unknown as Menu;
      },
      homePath: "/tmp/nodex-home",
      isInApplicationsFolder: true,
      setApplicationMenu: (menu) => applicationMenus.push(menu),
      setDockMenu: (menu) => dockMenus.push(menu),
      subscribeToFocus: (listener) => {
        notifyFocus = listener;
        return () => {
          notifyFocus = () => {};
        };
      },
    };
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      live({
        checkForUpdates: Effect.void,
        initialCommandKeymap: createCommandKeymapState({}, "macOS"),
        isPackaged: true,
        native,
        platform: "darwin",
        requestNewWindow: () => {
          newWindowCount += 1;
        },
        resourcesPath: "/tmp/Nodex.app/Contents/Resources",
        showMessage: () => Effect.succeed({ response: 0, checkboxChecked: false }),
        windows,
      }).pipe(Layer.provide(scopedCallbackRuntimeLive)),
      scope,
    );
    const runtime = Context.get(context, ApplicationMenuRuntime);
    const initialApplicationTemplate = templates.at(-1)!;
    const fileMenu = initialApplicationTemplate.find((item) => item.label === "File");
    const fileItems = fileMenu?.submenu as MenuItemConstructorOptions[];
    const newWindow = fileItems.find((item) => item.id === "file.newWindow");
    const closeWindow = fileItems.find((item) => item.id === "file.closeWindow");
    if (typeof newWindow?.click !== "function" || typeof closeWindow?.click !== "function") {
      throw new Error("Expected native window menu commands");
    }
    newWindow.click({} as never, {} as never, {} as never);
    closeWindow.click({} as never, {} as never, {} as never);
    assert.strictEqual(newWindowCount, 1);
    assert.strictEqual(closeCount, 1);

    const navigateMenu = initialApplicationTemplate.find((item) => item.label === "Navigate");
    const back = (navigateMenu?.submenu as MenuItemConstructorOptions[]).find(
      (item) => item.label === "Back",
    );
    if (typeof back?.click !== "function") throw new Error("Expected Back menu command");
    back.click({} as never, {} as never, {} as never);
    assert.deepEqual(sent, [{ channel: "navigate-back", args: [] }]);

    const edit = initialApplicationTemplate.find((item) => item.role === "editMenu");
    const redo = (edit?.submenu as MenuItemConstructorOptions[]).find(
      (item) => item.id === "edit.redo",
    );
    if (!redo?.click) throw new Error("Expected application-owned native Redo");
    redo.click({} as never, {} as never, {} as never);
    assert.deepEqual(sent.at(-1), { channel: "execute-focused-history", args: ["redo"] });
    let guestRedoCount = 0;
    focused = {
      id: 99,
      isDestroyed: () => false,
      undo: () => {},
      redo: () => {
        guestRedoCount += 1;
      },
    };
    redo.click({} as never, {} as never, {} as never);
    assert.strictEqual(guestRedoCount, 1);
    assert.strictEqual(sent.length, 2);

    focused = null;
    const generation = yield* runtime.bindHistory(1);
    const ready = {
      status: "ready",
      label: "Move Pages",
      acceptsIntent: true,
      reason: null,
      recoveryActions: [],
    } as const;
    const blocked = {
      status: "blocked",
      label: "Change Status",
      acceptsIntent: false,
      reason: "The Page changed.",
      recoveryActions: ["retry", "reset"],
    } as const;
    const snapshot = {
      ownerId: "view:one",
      generation: 1,
      revision: 3,
      undo: ready,
      redo: blocked,
    };
    yield* runtime.publishHistory(1, { generation, sequence: 2, snapshot });
    assert.strictEqual(redo.label, "Redo Change Status");
    assert.strictEqual(redo.enabled, false);
    yield* runtime.publishHistory(1, { generation, sequence: 1, snapshot: null });
    assert.strictEqual(redo.enabled, false);
    yield* runtime.publishHistory(1, {
      generation,
      sequence: 3,
      snapshot: { ...snapshot, revision: 2, redo: ready },
    });
    assert.strictEqual(redo.enabled, false);
    const nextGeneration = yield* runtime.bindHistory(1);
    yield* runtime.publishHistory(1, { generation, sequence: 4, snapshot });
    assert.strictEqual(redo.label, "Redo");
    assert.strictEqual(redo.enabled, true);
    yield* runtime.publishHistory(1, { generation: nextGeneration, sequence: 1, snapshot });
    focused = { id: 99, isDestroyed: () => false, undo: () => {}, redo: () => {} };
    notifyFocus();
    assert.strictEqual(redo.label, "Redo");
    assert.strictEqual(redo.enabled, true);
    focused = null;
    notifyFocus();
    assert.strictEqual(redo.enabled, false);
    yield* runtime.publishHistory(1, { generation: nextGeneration, sequence: 2, snapshot: null });
    assert.strictEqual(redo.enabled, true);

    runtime.refresh(createCommandKeymapState({ newWindow: ["CmdOrCtrl+Alt+N"] }, "macOS"));
    assert.strictEqual(templates.at(-2)?.[0]?.accelerator, "CommandOrControl+Alt+N");
    assert.isNotNull(applicationMenus.at(-1));
    assert.isNotNull(dockMenus.at(-1));

    yield* Scope.close(scope, Exit.void);
    assert.isNull(applicationMenus.at(-1));
    assert.isNull(dockMenus.at(-1));
  }),
);
