import {
  ApplicationMenuSnapshots,
  findNativeMenuAccelerator,
  matchesNativeMenuAccelerator,
} from "../application-menu-snapshot";
import type { ApplicationMenuSnapshot } from "../../shared/application-menu";
import type { BrowserWindow } from "electron";
import { WebContentsDestructionSubscriptions } from "../platform/electron/WebContentsDestructionSubscriptions";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import {
  app,
  Menu,
  webContents,
  nativeTheme,
  type WebContents,
  type MenuItemConstructorOptions,
  type MessageBoxOptions,
  type MessageBoxReturnValue,
} from "electron";
import {
  EXECUTE_FOCUSED_HISTORY_CHANNEL,
  type FocusedHistoryPublication,
  type SurfaceHistorySnapshot,
} from "../../shared/surface-history";
import { join } from "node:path";
import type { CommandKeymapState } from "../../shared/command-keybindings";
import {
  getPrimaryCommandAccelerator,
  NEXT_PANEL_TAB_COMMAND_ID,
  PREVIOUS_PANEL_TAB_COMMAND_ID,
  toElectronAccelerator,
} from "../../shared/command-keybindings";
import {
  CLOSE_PANEL_TAB_HOST_CHANNEL,
  CYCLE_PANEL_TAB_NEXT_HOST_CHANNEL,
  CYCLE_PANEL_TAB_PREVIOUS_HOST_CHANNEL,
  NAVIGATE_BACK_HOST_CHANNEL,
  NAVIGATE_FORWARD_HOST_CHANNEL,
  WORKBENCH_CONTENT_SEARCH_COMMAND,
  WORKBENCH_THREAD_RENAME_COMMAND,
  WORKBENCH_SIDEBAR_TOGGLE_COMMAND,
  type WorkbenchContentSearchHostChannel,
  type WorkbenchNavigationHostChannel,
  type WorkbenchPanelTabCloseHostChannel,
  type WorkbenchPanelTabCycleHostChannel,
  type WorkbenchSidebarToggleHostChannel,
  type WorkbenchThreadRenameHostChannel,
} from "../../shared/window-navigation";
import {
  EXECUTE_WORKBENCH_COMMAND_HOST_CHANNEL,
  type WorkbenchCommandInvocation,
} from "../../shared/workbench-commands";
import {
  buildNodexSetupMenuItems,
  buildWindowFileMenu,
  buildWindowEditMenu,
  buildWorkbenchViewMenu,
} from "../application-menu";
import { runAgentSkillSetup } from "../agent-skill-setup";
import { installCliCommand } from "../cli-command-installer";
import { safeSendToWindow } from "../ipc-safe-send";
import { getLogger } from "../logging/logger";
import { ScopedCallbackRuntime } from "../app/ScopedCallbackRuntime";
import type { AppUpdateRuntimeError } from "./AppUpdateRuntime";
import type { WindowRuntimeService } from "../window-runtime/WindowRuntime";
import { syncWindowNavigationChrome, type WindowZoomCommand } from "../window-navigation-chrome";
import { getFocusedFrameOwner } from "../platform/electron/FocusedWebContents";

export interface ApplicationMenuNativePort {
  readonly subscribeToWindowInput?: (
    window: BrowserWindow,
    listener: (event: Electron.Event, input: Electron.Input) => void,
  ) => () => void;
  readonly shouldUseDarkColors: () => boolean;
  readonly getFocusedWebContents: () =>
    | (Pick<
        WebContents,
        "id" | "isDestroyed" | "undo" | "redo" | "getZoomLevel" | "setZoomLevel"
      > & { readonly hostWebContents?: Pick<WebContents, "id"> | null })
    | null;
  readonly buildFromTemplate: (template: MenuItemConstructorOptions[]) => Menu;
  readonly homePath: string;
  readonly isInApplicationsFolder: boolean;
  readonly setApplicationMenu: (menu: Menu | null) => void;
  readonly setDockMenu: (menu: Menu | null) => void;
  readonly subscribeToFocus: (listener: () => void) => () => void;
}

export interface ApplicationMenuRuntimeOptions {
  readonly checkForUpdates: Effect.Effect<unknown, AppUpdateRuntimeError>;
  readonly environmentPath?: string;
  readonly initialCommandKeymap: CommandKeymapState;
  readonly isPackaged: boolean;
  readonly native?: ApplicationMenuNativePort;
  readonly platform: NodeJS.Platform;
  readonly requestNewWindow: () => void;
  readonly resourcesPath: string;
  readonly showMessage: (options: MessageBoxOptions) => Effect.Effect<MessageBoxReturnValue>;
  readonly windows: WindowRuntimeService;
}

export class ApplicationMenuRuntime extends Context.Service<
  ApplicationMenuRuntime,
  {
    readonly snapshot: (webContentsId: number) => Effect.Effect<ApplicationMenuSnapshot>;
    readonly invoke: (webContentsId: number, itemId: string) => Effect.Effect<boolean>;
    readonly refresh: (commandKeymap: CommandKeymapState) => void;
    readonly bindHistory: (webContentsId: number) => Effect.Effect<number>;
    readonly publishHistory: (
      webContentsId: number,
      publication: FocusedHistoryPublication,
    ) => Effect.Effect<void>;
  }
>()("nodex/main/host-runtime/ApplicationMenuRuntime") {}

const electronNative = (
  rendererDestruction: WebContentsDestructionSubscriptions["Service"],
): ApplicationMenuNativePort => ({
  subscribeToWindowInput: (window, listener) => {
    const contents = window.webContents;
    contents.on("before-input-event", listener);
    return () => {
      if (!contents.isDestroyed()) contents.off("before-input-event", listener);
    };
  },
  shouldUseDarkColors: () => nativeTheme.shouldUseDarkColors,
  getFocusedWebContents: getFocusedFrameOwner,
  buildFromTemplate: (template) => Menu.buildFromTemplate(template),
  homePath: app.getPath("home"),
  isInApplicationsFolder:
    typeof app.isInApplicationsFolder !== "function" || app.isInApplicationsFolder(),
  setApplicationMenu: (menu) => Menu.setApplicationMenu(menu),
  setDockMenu: (menu) => app.dock?.setMenu(menu ?? Menu.buildFromTemplate([])),
  subscribeToFocus: (listener) => {
    const releases = new Map<WebContents, () => void>();
    const attach = (contents: WebContents) => {
      if (contents.isDestroyed() || releases.has(contents)) return;
      const release = () => {
        contents.off("focus", listener);
        contents.off("blur", listener);
        releaseDestruction();
        releases.delete(contents);
      };
      const destroyed = () => {
        release();
        listener();
      };
      contents.on("focus", listener);
      contents.on("blur", listener);
      const releaseDestruction = rendererDestruction.subscribe(contents, destroyed);
      releases.set(contents, release);
    };
    const created = (_event: Electron.Event, contents: WebContents) => attach(contents);
    webContents.getAllWebContents().forEach(attach);
    app.on("web-contents-created", created);
    app.on("browser-window-focus", listener);
    return () => {
      app.off("web-contents-created", created);
      app.off("browser-window-focus", listener);
      for (const release of releases.values()) release();
    };
  },
});

export const live = (
  options: ApplicationMenuRuntimeOptions,
): Layer.Layer<ApplicationMenuRuntime, never, ScopedCallbackRuntime> =>
  Layer.effect(
    ApplicationMenuRuntime,
    Effect.gen(function* () {
      const rendererDestruction = yield* WebContentsDestructionSubscriptions;
      const callbacks = yield* ScopedCallbackRuntime;
      const logger = getLogger({ component: "application-menu-runtime" });
      const native = options.native ?? electronNative(rendererDestruction);
      const reportFailure = (operation: string) =>
        Effect.catchCause((cause) =>
          Effect.sync(() => logger.warn("Application menu action failed", { operation, cause })),
        );
      const fork = <A, E>(operation: string, effect: Effect.Effect<A, E>): void => {
        callbacks.fork(effect.pipe(reportFailure(operation), Effect.asVoid));
      };
      const snapshots = new ApplicationMenuSnapshots();
      const installedWindows = new Map<number, () => void>();
      let invocationWindow: BrowserWindow | null = null;
      const targetWindow = () => invocationWindow ?? options.windows.getLastFocused();
      const focusedContents = () => {
        const focused = native.getFocusedWebContents();
        if (!invocationWindow) return focused;
        if (focused?.id === invocationWindow.webContents.id) return focused;
        const owner = focused?.hostWebContents;
        return owner?.id === invocationWindow.webContents.id
          ? focused
          : invocationWindow.webContents;
      };
      const zoomFocusedContents = (command: WindowZoomCommand): void => {
        const window = targetWindow();
        const focused = focusedContents() ?? window?.webContents;
        if (!focused || focused.isDestroyed()) return;
        focused.setZoomLevel(
          command === "reset" ? 0 : focused.getZoomLevel() + (command === "in" ? 0.5 : -0.5),
        );
        if (focused.id !== window?.webContents.id) return;
        // Chromium shares normal page zoom by origin, including other app windows.
        for (const candidate of options.windows.all()) {
          syncWindowNavigationChrome(candidate, options.platform, native.shouldUseDarkColors());
        }
      };
      let applicationMenu: Menu | null = null;
      let historyGeneration = 0;
      const historyByWindow = new Map<number, FocusedHistoryPublication>();
      const updateHistoryItems = () => {
        const window = targetWindow();
        const focused = focusedContents();
        const hostId = window?.webContents.id;
        const snapshot: SurfaceHistorySnapshot | null =
          hostId !== undefined && (!focused || focused.id === hostId)
            ? (historyByWindow.get(hostId)?.snapshot ?? null)
            : null;
        for (const direction of ["undo", "redo"] as const) {
          const item = applicationMenu?.getMenuItemById(`edit.${direction}`);
          if (!item) continue;
          const capability = snapshot?.[direction];
          const action = direction === "undo" ? "Undo" : "Redo";
          item.label = capability?.label ? `${action} ${capability.label}` : action;
          item.enabled = capability?.acceptsIntent ?? true;
        }
      };
      const bindHistory = Effect.fn("ApplicationMenuRuntime.bindHistory")((webContentsId: number) =>
        Effect.sync(() => {
          const generation = ++historyGeneration;
          historyByWindow.set(webContentsId, { generation, sequence: -1, snapshot: null });
          updateHistoryItems();
          return generation;
        }),
      );
      const publishHistory = Effect.fn("ApplicationMenuRuntime.publishHistory")(
        (webContentsId: number, publication: FocusedHistoryPublication) =>
          Effect.sync(() => {
            const previous = historyByWindow.get(webContentsId);
            if (
              !previous ||
              previous.generation !== publication.generation ||
              previous.sequence >= publication.sequence
            )
              return;
            const before = previous.snapshot;
            const next = publication.snapshot;
            if (
              before &&
              next &&
              before.ownerId === next.ownerId &&
              (before.generation > next.generation ||
                (before.generation === next.generation && before.revision > next.revision))
            )
              return;
            historyByWindow.set(webContentsId, publication);
            updateHistoryItems();
          }),
      );
      const installCommandLineTool = Effect.gen(function* () {
        const result = yield* Effect.sync(() =>
          installCliCommand({
            environmentPath: options.environmentPath,
            sourcePath: join(options.resourcesPath, "bin/nodex"),
            targetPath: join(native.homePath, ".local/bin/nodex"),
          }),
        );
        const statusMessage =
          result.status === "already-installed"
            ? "The Nodex command line tool is already installed."
            : result.status === "updated"
              ? "The Nodex command line tool was updated."
              : "The Nodex command line tool was installed.";
        const pathMessage = result.pathConfigured
          ? `Run it as:\n\nnodex --help\n\nInstalled link: ${result.targetPath}`
          : `Installed link: ${result.targetPath}\n\nAdd this line to your shell profile, then open a new terminal:\n\nexport PATH="$HOME/.local/bin:$PATH"`;
        yield* options.showMessage({
          type: "info",
          buttons: ["OK"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          message: statusMessage,
          detail: pathMessage,
        });
        yield* runAgentSkillSetup({
          cliPath: result.sourcePath,
          onlyWhenMissing: true,
          pathConfigured: result.pathConfigured,
          showMessageBox: options.showMessage,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() =>
            logger.error("Could not install the Nodex command line tool", { cause }),
          ).pipe(
            Effect.andThen(
              options.showMessage({
                type: "error",
                buttons: ["OK"],
                defaultId: 0,
                cancelId: 0,
                noLink: true,
                message: "Could not install the Nodex command line tool.",
                detail: Cause.pretty(cause),
              }),
            ),
          ),
        ),
      );
      const setupAgentSkills = runAgentSkillSetup({
        cliPath: join(options.resourcesPath, "bin/nodex"),
        showMessageBox: options.showMessage,
      });

      const snapshot = (webContentsId: number) =>
        Effect.sync(() => {
          const window = options.windows.get(webContentsId);
          if (
            !window ||
            window.isDestroyed() ||
            window.webContents.isDestroyed() ||
            options.platform !== "win32"
          )
            return { menus: [] };
          invocationWindow = window;
          try {
            updateHistoryItems();
          } finally {
            invocationWindow = null;
          }
          const result = snapshots.read(webContentsId, applicationMenu);
          if (!installedWindows.has(webContentsId)) {
            const release =
              native.subscribeToWindowInput?.(window, (event, input) => {
                if (input.type !== "keyDown" || input.isAutoRepeat || input.isComposing) return;
                const item = findNativeMenuAccelerator(applicationMenu, (accelerator) =>
                  matchesNativeMenuAccelerator(
                    {
                      key: input.key,
                      code: input.code,
                      ctrlKey: input.control,
                      altKey: input.alt,
                      shiftKey: input.shift,
                      metaKey: input.meta,
                    },
                    accelerator,
                  ),
                );
                if (!item) return;
                event.preventDefault();
                invocationWindow = window;
                try {
                  item.click(
                    { triggeredByAccelerator: true } as Electron.KeyboardEvent,
                    window,
                    focusedContents() as WebContents,
                  );
                } finally {
                  invocationWindow = null;
                }
              }) ?? (() => {});
            installedWindows.set(webContentsId, release);
            window.setAutoHideMenuBar(true);
            window.removeMenu();
          }
          return result;
        });
      const invoke = (webContentsId: number, itemId: string) =>
        Effect.sync(() => {
          const window = options.windows.get(webContentsId);
          if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return false;
          invocationWindow = window;
          try {
            updateHistoryItems();
            const item = snapshots.resolve(webContentsId, itemId);
            if (!item) return false;
            item.click(
              { triggeredByAccelerator: false } as Electron.KeyboardEvent,
              window,
              focusedContents() as WebContents,
            );
            return true;
          } finally {
            invocationWindow = null;
          }
        });
      const refresh = (commandKeymap: CommandKeymapState): void => {
        const accelerator = (commandId: string): string | undefined =>
          toElectronAccelerator(getPrimaryCommandAccelerator(commandKeymap, commandId));
        const sendWorkbenchCommand = (invocation: WorkbenchCommandInvocation): void => {
          safeSendToWindow(targetWindow(), EXECUTE_WORKBENCH_COMMAND_HOST_CHANNEL, [invocation]);
        };
        const sendNavigationMessage = (
          channel:
            | WorkbenchNavigationHostChannel
            | WorkbenchSidebarToggleHostChannel
            | WorkbenchThreadRenameHostChannel
            | WorkbenchContentSearchHostChannel
            | WorkbenchPanelTabCycleHostChannel
            | WorkbenchPanelTabCloseHostChannel,
        ): void => {
          safeSendToWindow(targetWindow(), channel);
        };
        const dockTemplate: MenuItemConstructorOptions[] = [
          {
            label: "New Window",
            accelerator: accelerator("newWindow"),
            click: options.requestNewWindow,
          },
        ];
        native.setDockMenu(native.buildFromTemplate(dockTemplate));

        const appTemplate: MenuItemConstructorOptions[] = [
          ...(options.platform === "darwin"
            ? [
                {
                  role: "appMenu",
                  submenu: [
                    {
                      label: "Check for Updates…",
                      click: () => fork("check-for-updates", options.checkForUpdates),
                    },
                    ...buildNodexSetupMenuItems({
                      enabled: options.isPackaged && native.isInApplicationsFolder,
                      onInstallCli: () => fork("install-cli", installCommandLineTool),
                      onSetupAgentSkills: () => fork("setup-agent-skills", setupAgentSkills),
                    }),
                  ],
                } satisfies MenuItemConstructorOptions,
              ]
            : []),
          buildWindowFileMenu({
            commandKeymapState: commandKeymap,
            onNewWindow: options.requestNewWindow,
            onCloseWindow: () => {
              const window = targetWindow();
              if (!window || window.isDestroyed()) return;
              window.close();
            },
          }),
          buildWindowEditMenu(options.platform, (direction) => {
            const window = targetWindow();
            const focused = focusedContents();
            if (focused && focused.id !== window?.webContents.id) {
              if (!focused.isDestroyed()) focused[direction]();
              return;
            }
            safeSendToWindow(window, EXECUTE_FOCUSED_HISTORY_CHANNEL, [direction]);
          }),
          {
            label: "Navigate",
            submenu: [
              {
                label: "Back",
                accelerator: accelerator("navigateBack"),
                click: () => sendNavigationMessage(NAVIGATE_BACK_HOST_CHANNEL),
              },
              {
                label: "Forward",
                accelerator: accelerator("navigateForward"),
                click: () => sendNavigationMessage(NAVIGATE_FORWARD_HOST_CHANNEL),
              },
              { type: "separator" },
              {
                label: WORKBENCH_CONTENT_SEARCH_COMMAND.label,
                accelerator: accelerator(WORKBENCH_CONTENT_SEARCH_COMMAND.id),
                click: () => sendNavigationMessage(WORKBENCH_CONTENT_SEARCH_COMMAND.hostChannel),
              },
              { type: "separator" },
              {
                label: "Previous Panel Tab",
                accelerator: accelerator(PREVIOUS_PANEL_TAB_COMMAND_ID),
                click: () => sendNavigationMessage(CYCLE_PANEL_TAB_PREVIOUS_HOST_CHANNEL),
              },
              {
                label: "Next Panel Tab",
                accelerator: accelerator(NEXT_PANEL_TAB_COMMAND_ID),
                click: () => sendNavigationMessage(CYCLE_PANEL_TAB_NEXT_HOST_CHANNEL),
              },
              {
                label: "Close Panel Tab",
                accelerator: accelerator("closeTab"),
                click: () => sendNavigationMessage(CLOSE_PANEL_TAB_HOST_CHANNEL),
              },
              { type: "separator" },
              {
                label: WORKBENCH_SIDEBAR_TOGGLE_COMMAND.label,
                accelerator: accelerator("toggleSidebar"),
                click: () => sendNavigationMessage(WORKBENCH_SIDEBAR_TOGGLE_COMMAND.hostChannel),
              },
              {
                label: WORKBENCH_THREAD_RENAME_COMMAND.label,
                accelerator: accelerator("renameThread"),
                click: () => sendNavigationMessage(WORKBENCH_THREAD_RENAME_COMMAND.hostChannel),
              },
            ],
          },
          buildWorkbenchViewMenu(commandKeymap, sendWorkbenchCommand, zoomFocusedContents),
          { role: "windowMenu" },
        ];
        if (options.platform === "win32") {
          const file = appTemplate.find((item) => item.label === "File")!;
          (file.submenu as MenuItemConstructorOptions[]).push(
            { type: "separator" },
            { role: "quit", accelerator: "Ctrl+Q" },
          );
          const edit = appTemplate.find((item) => item.role === "editMenu")!;
          edit.label = "Edit";
          (edit.submenu as MenuItemConstructorOptions[]).push(
            { type: "separator" },
            {
              label: "Settings",
              accelerator: accelerator("settings"),
              click: () => sendWorkbenchCommand({ commandId: "settings", source: "menu" }),
            },
          );
          const navigationIndex = appTemplate.findIndex((item) => item.label === "Navigate");
          const [navigation] = appTemplate.splice(navigationIndex, 1);
          const view = appTemplate.find((item) => item.label === "View")!;
          (view.submenu as MenuItemConstructorOptions[]).push({ type: "separator" }, navigation!);
          appTemplate.splice(
            appTemplate.findIndex((item) => item.role === "windowMenu"),
            1,
          );
          appTemplate.push({
            label: "Help",
            submenu: [{ role: "about" }],
          });
        }
        snapshots.clear();
        applicationMenu = native.buildFromTemplate(appTemplate);
        native.setApplicationMenu(applicationMenu);
        for (const id of installedWindows.keys()) options.windows.get(id)?.removeMenu();
        updateHistoryItems();
      };

      yield* Effect.acquireRelease(
        Effect.sync(() => native.subscribeToFocus(updateHistoryItems)),
        (release) => Effect.sync(release),
      );
      yield* options.windows.events.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event.kind === "released") {
              historyByWindow.delete(event.window.webContentsId);
              snapshots.release(event.window.webContentsId);
              installedWindows.get(event.window.webContentsId)?.();
              installedWindows.delete(event.window.webContentsId);
            }
            updateHistoryItems();
          }),
        ),
        Effect.forkScoped,
      );

      return yield* Effect.acquireRelease(
        Effect.sync(() => {
          refresh(options.initialCommandKeymap);
          return ApplicationMenuRuntime.of({
            refresh,
            bindHistory,
            publishHistory,
            snapshot,
            invoke,
          });
        }),
        () =>
          Effect.sync(() => {
            native.setDockMenu(null);
            native.setApplicationMenu(null);
            applicationMenu = null;
            historyByWindow.clear();
            snapshots.clear();
            for (const release of installedWindows.values()) release();
            installedWindows.clear();
          }),
      );
    }),
  ).pipe(Layer.provide(WebContentsDestructionSubscriptions.live));
