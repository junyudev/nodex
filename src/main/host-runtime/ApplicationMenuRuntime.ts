import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import {
  app,
  Menu,
  webContents,
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

export interface ApplicationMenuNativePort {
  readonly getFocusedWebContents: () => Pick<
    WebContents,
    "id" | "isDestroyed" | "undo" | "redo"
  > | null;
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
    readonly refresh: (commandKeymap: CommandKeymapState) => void;
    readonly bindHistory: (webContentsId: number) => Effect.Effect<number>;
    readonly publishHistory: (
      webContentsId: number,
      publication: FocusedHistoryPublication,
    ) => Effect.Effect<void>;
  }
>()("nodex/main/host-runtime/ApplicationMenuRuntime") {}

const electronNative = (): ApplicationMenuNativePort => ({
  getFocusedWebContents: () => webContents.getFocusedWebContents(),
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
        contents.off("destroyed", destroyed);
        releases.delete(contents);
      };
      const destroyed = () => {
        release();
        listener();
      };
      contents.on("focus", listener);
      contents.on("blur", listener);
      contents.on("destroyed", destroyed);
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
      const callbacks = yield* ScopedCallbackRuntime;
      const logger = getLogger({ component: "application-menu-runtime" });
      const native = options.native ?? electronNative();
      const reportFailure = (operation: string) =>
        Effect.catchCause((cause) =>
          Effect.sync(() => logger.warn("Application menu action failed", { operation, cause })),
        );
      const fork = <A, E>(operation: string, effect: Effect.Effect<A, E>): void => {
        callbacks.fork(effect.pipe(reportFailure(operation), Effect.asVoid));
      };
      const targetWindow = () => options.windows.getLastFocused();
      let applicationMenu: Menu | null = null;
      let historyGeneration = 0;
      const historyByWindow = new Map<number, FocusedHistoryPublication>();
      const updateHistoryItems = () => {
        const window = targetWindow();
        const focused = native.getFocusedWebContents();
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
            const focused = native.getFocusedWebContents();
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
          buildWorkbenchViewMenu(commandKeymap, sendWorkbenchCommand),
          { role: "windowMenu" },
        ];
        applicationMenu = native.buildFromTemplate(appTemplate);
        native.setApplicationMenu(applicationMenu);
        updateHistoryItems();
      };

      yield* Effect.acquireRelease(
        Effect.sync(() => native.subscribeToFocus(updateHistoryItems)),
        (release) => Effect.sync(release),
      );
      yield* options.windows.events.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event.kind === "released") historyByWindow.delete(event.window.webContentsId);
            updateHistoryItems();
          }),
        ),
        Effect.forkScoped,
      );

      return yield* Effect.acquireRelease(
        Effect.sync(() => {
          refresh(options.initialCommandKeymap);
          return ApplicationMenuRuntime.of({ refresh, bindHistory, publishHistory });
        }),
        () =>
          Effect.sync(() => {
            native.setDockMenu(null);
            native.setApplicationMenu(null);
            applicationMenu = null;
            historyByWindow.clear();
          }),
      );
    }),
  );
