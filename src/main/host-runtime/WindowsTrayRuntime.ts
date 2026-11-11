import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { app, Menu, nativeTheme, shell, Tray, type MenuItemConstructorOptions } from "electron";
import { join } from "node:path";
import type { WindowsStartupStatus } from "../../shared/windows-startup";
import { MainConfig } from "../app/MainConfig";
import { ScopedCallbackRuntime } from "../app/ScopedCallbackRuntime";
import { getLogger } from "../logging/logger";
import { parseWindowsAppUpdateConfig } from "../windows-app-update-config";
import {
  trayChatLabel,
  windowsLoginItemEnabled,
  WINDOWS_STARTUP_ARGUMENT,
  windowsTrayGuid,
  type TrayChatGroup,
} from "../windows-desktop-policy";

export type WindowsTrayAction =
  | { readonly kind: "open" | "new-chat" | "menu" | "quit" }
  | { readonly kind: "chat"; readonly sessionId: string };

export interface WindowsTrayNativePort {
  readonly create: (
    icon: string,
    guid: string | undefined,
  ) => {
    readonly destroy: () => void;
    readonly setIcon: (icon: string) => void;
    readonly subscribe: (action: (action: WindowsTrayAction) => void) => () => void;
    readonly showMenu: (
      groups: readonly TrayChatGroup[],
      action: (action: WindowsTrayAction) => void,
    ) => void;
  };
  readonly isDark: () => boolean;
  readonly subscribeTheme: (refresh: () => void) => () => void;
  readonly startupEnabled: (executable: string) => boolean;
  readonly openStartupSettings: () => Promise<void>;
}

const native: WindowsTrayNativePort = {
  create: (icon, guid) => {
    const tray = new Tray(icon, guid);
    tray.setToolTip("Nodex");
    return {
      destroy: () => tray.destroy(),
      setIcon: (path) => tray.setImage(path),
      subscribe: (action) => {
        const open = () => action({ kind: "open" });
        const menu = () => action({ kind: "menu" });
        tray.on("click", open);
        tray.on("right-click", menu);
        return () => {
          tray.off("click", open);
          tray.off("right-click", menu);
        };
      },
      showMenu: (groups, action) => {
        const chatItem = (chat: TrayChatGroup["chats"][number]): MenuItemConstructorOptions => ({
          label: trayChatLabel(chat.title),
          sublabel: chat.projectName ?? "Chats",
          click: () => action({ kind: "chat", sessionId: chat.sessionId }),
        });
        const sections = groups.flatMap((group, index): MenuItemConstructorOptions[] => [
          ...(index ? [{ type: "separator" as const }] : []),
          { label: group.label, enabled: false },
          ...group.chats.slice(0, 3).map(chatItem),
          ...(group.chats.length > 3
            ? [{ label: "More", submenu: group.chats.slice(3).map(chatItem) }]
            : []),
        ]);
        tray.popUpContextMenu(
          Menu.buildFromTemplate([
            ...sections,
            ...(sections.length ? [{ type: "separator" as const }] : []),
            { label: "New chat", click: () => action({ kind: "new-chat" }) },
            { type: "separator" },
            {
              label: Menu.buildFromTemplate([{ role: "quit" }]).items[0]?.label ?? "Quit Nodex",
              click: () => action({ kind: "quit" }),
            },
          ]),
        );
      },
    };
  },
  isDark: () => nativeTheme.shouldUseDarkColorsForSystemIntegratedUI,
  subscribeTheme: (refresh) => {
    nativeTheme.on("updated", refresh);
    return () => nativeTheme.off("updated", refresh);
  },
  startupEnabled: (executable) => {
    const status = app.getLoginItemSettings({ path: executable, args: [WINDOWS_STARTUP_ARGUMENT] });
    return windowsLoginItemEnabled(executable, status);
  },
  openStartupSettings: () => shell.openExternal("ms-settings:startupapps"),
};

export class WindowsTrayError extends Schema.TaggedError<WindowsTrayError>()("WindowsTrayError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

export class WindowsTrayRuntime extends Context.Service<
  WindowsTrayRuntime,
  {
    readonly actions: Stream.Stream<WindowsTrayAction>;
    readonly canHideLastWindow: () => boolean;
    readonly markApplicationReady: Effect.Effect<void>;
    readonly markApplicationFailed: Effect.Effect<void>;
    readonly showMenu: (groups: readonly TrayChatGroup[]) => Effect.Effect<void>;
    readonly startupStatus: Effect.Effect<WindowsStartupStatus, WindowsTrayError>;
    readonly openStartupSettings: Effect.Effect<void, WindowsTrayError>;
  }
>()("nodex/main/host-runtime/WindowsTrayRuntime") {}

/** The process Scope owns the native icon, theme observation and pre-ready action ingress. */
export const live = (
  port: WindowsTrayNativePort = native,
): Layer.Layer<
  WindowsTrayRuntime,
  never,
  MainConfig | FileSystem.FileSystem | ScopedCallbackRuntime
> =>
  Layer.effect(
    WindowsTrayRuntime,
    Effect.gen(function* () {
      const config = yield* MainConfig;
      const callbacks = yield* ScopedCallbackRuntime;
      const fs = yield* FileSystem.FileSystem;
      const actions = yield* Queue.dropping<WindowsTrayAction>(32);
      yield* Effect.addFinalizer(() => Queue.shutdown(actions));
      let accepting = true;
      let ready = false;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          accepting = false;
          ready = false;
        }),
      );
      const emit = (action: WindowsTrayAction) => {
        if (accepting) callbacks.fork(Queue.offer(actions, action));
      };
      const windows = config.platform === "win32";
      const supported = windows && config.isPackaged;
      const iconPath = () =>
        join(
          config.isPackaged ? config.resourcesPath : join(config.projectRootPath, "resources"),
          "windows",
          port.isDark() ? "tray-dark.ico" : "tray-light.ico",
        );
      const tray = windows
        ? yield* Effect.gen(function* () {
            const updates = config.isPackaged
              ? yield* fs
                  .readFileString(join(config.resourcesPath, "native", "app-update.json"))
                  .pipe(Effect.map((text) => parseWindowsAppUpdateConfig(JSON.parse(text)).updates))
              : "disabled";
            return yield* Effect.acquireRelease(
              Effect.sync(() =>
                port.create(iconPath(), windowsTrayGuid(config.isPackaged, updates)),
              ),
              (icon) => Effect.sync(icon.destroy),
            );
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => {
                getLogger({ component: "windows-tray" }).error(
                  "Could not create the notification-area icon",
                  { cause },
                );
                return null;
              }),
            ),
          )
        : null;
      if (tray) {
        yield* Effect.acquireRelease(
          Effect.sync(() => tray.subscribe(emit)),
          (release) => Effect.sync(release),
        );
        yield* Effect.acquireRelease(
          Effect.sync(() => port.subscribeTheme(() => tray.setIcon(iconPath()))),
          (release) => Effect.sync(release),
        );
      }
      return WindowsTrayRuntime.of({
        actions: Stream.fromQueue(actions),
        canHideLastWindow: () => ready && tray !== null,
        markApplicationReady: Effect.sync(() => {
          ready = true;
        }),
        markApplicationFailed: Effect.sync(() => {
          ready = false;
        }),
        showMenu: (groups) =>
          Effect.sync(() => {
            if (accepting) tray?.showMenu(groups, emit);
          }),
        startupStatus: Effect.try({
          try: () => ({
            supported,
            enabled: supported && port.startupEnabled(config.runtimeBinaryPath),
          }),
          catch: (cause) => new WindowsTrayError({ operation: "read-startup-status", cause }),
        }),
        openStartupSettings: windows
          ? Effect.tryPromise({
              try: port.openStartupSettings,
              catch: (cause) => new WindowsTrayError({ operation: "open-startup-settings", cause }),
            })
          : Effect.void,
      });
    }),
  );
