import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { BrowserWindow } from "electron";
import { EMPTY_MINI_COVERAGE, type MiniCoverage } from "../../shared/mini";
import { APP_RENDERER_URL } from "../../shared/app-renderer-policy";
import type {
  CommandKeybindingRejection,
  CommandKeymapState,
} from "../../shared/command-keybindings";
import {
  CAPTURE_TO_INBOX_COMMAND_ID,
  EXECUTE_WORKBENCH_COMMAND_HOST_CHANNEL,
  type WorkbenchCommandInvocation,
} from "../../shared/workbench-commands";
import { MainConfig } from "../app/MainConfig";
import { safeSendToWindow } from "../ipc-safe-send";
import { ElectronDesktop } from "../platform/electron/ElectronDesktop";
import type { MiniPlacement } from "../settings/application-settings-persistence";
import { loadNativeClipboardBridge } from "../platform/electron/native-clipboard";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { WindowRuntime } from "../window-runtime/WindowRuntime";
import { MiniWindowController } from "./mini-window-controller";
import { GlobalMiniShortcut } from "./global-mini-shortcut";

export class MiniRuntimeError extends Schema.TaggedError<MiniRuntimeError>()("MiniRuntimeError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

export interface MiniRuntimeService {
  readonly restingCoverage: () => MiniCoverage;
  readonly panel: MiniWindowController | null;
  readonly syncCommandKeymap: (
    state: CommandKeymapState,
  ) => Effect.Effect<CommandKeybindingRejection | null, MiniRuntimeError>;
  readonly restoreCommandKeymap: (
    state: CommandKeymapState,
  ) => Effect.Effect<void, MiniRuntimeError>;
  readonly decorateKeymap: (state: CommandKeymapState) => CommandKeymapState;
  readonly withDialog: <A>(senderId: number, open: () => Promise<A>) => Promise<A>;
}

export class MiniRuntime extends Context.Service<MiniRuntime, MiniRuntimeService>()(
  "nodex/main/mini/MiniRuntime",
) {}

export const live = (preloadPath: string) =>
  Layer.effect(
    MiniRuntime,
    Effect.gen(function* () {
      const config = yield* MainConfig;
      const settings = yield* ApplicationSettings;
      const windows = yield* WindowRuntime;
      const supported = config.platform === "darwin" || config.platform === "win32";
      if (!supported) {
        return MiniRuntime.of({
          panel: null,
          restingCoverage: () => EMPTY_MINI_COVERAGE,
          syncCommandKeymap: () => Effect.succeed(null),
          restoreCommandKeymap: () => Effect.void,
          decorateKeymap: (state) => state,
          withDialog: (_, open) => open(),
        });
      }

      const initial = yield* settings.snapshot().pipe(Effect.orDie);
      const desktop = yield* ElectronDesktop;
      let screenLocked = false;
      for (const locked of [true, false]) {
        yield* desktop.onPowerEvent(
          locked ? "lock-screen" : "unlock-screen",
          Effect.sync(() => {
            screenLocked = locked;
          }),
        );
      }
      const placements = yield* Queue.unbounded<MiniPlacement>();
      yield* Effect.addFinalizer(() => Queue.shutdown(placements));
      yield* Queue.take(placements).pipe(
        Effect.flatMap((input) => settings.update({ type: "update-mini-placement", input })),
        Effect.catch((error) => Effect.logWarning("Could not save Mini placement", error)),
        Effect.forever,
        Effect.forkScoped({ startImmediately: true }),
      );
      const miniFocusProbe =
        config.platform === "darwin" &&
        !config.isPackaged &&
        config.environment.NODEX_DEV_MINI_SIGNAL === "1";
      const panel = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new MiniWindowController({
              windows,
              preloadPath,
              rendererUrl: config.rendererUrl ?? APP_RENDERER_URL,
              miniFocusProbe,
              visibility: initial.miniVisibility,
              placement: initial.miniPlacement,
              savePlacement: (placement) => {
                Queue.offerUnsafe(placements, placement);
              },
              native:
                config.platform === "darwin"
                  ? loadNativeClipboardBridge({
                      packaged: config.isPackaged,
                      resourcesPath: config.resourcesPath,
                      appPath: config.projectRootPath,
                      architecture: config.arch,
                    })
                  : null,
            }),
        ),
        (controller) => Effect.sync(() => controller.dispose()),
      );
      yield* windows.events.pipe(
        Stream.filter(({ kind }) => kind === "focus-changed" || kind === "released"),
        Stream.runForEach(() => Effect.sync(() => panel.syncWorkbenchFocus())),
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* settings.miniVisibilityChanges.pipe(
        Stream.runForEach((visibility) =>
          Effect.sync(() => panel.apply({ kind: "presence", update: { visibility } })),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
      const pressed = (): void => {
        const focused = BrowserWindow.getFocusedWindow();
        if (focused && windows.has(focused.webContents.id)) {
          safeSendToWindow(focused, EXECUTE_WORKBENCH_COMMAND_HOST_CHANNEL, [
            {
              commandId: CAPTURE_TO_INBOX_COMMAND_ID,
              source: "keyboard_shortcut",
            } satisfies WorkbenchCommandInvocation,
          ]);
          return;
        }
        panel.apply({ kind: "shortcut" });
      };
      // An isolated development instance can exercise the real handler without Accessibility
      // access to synthesize a system-wide keystroke.
      if (miniFocusProbe) {
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            process.on("SIGUSR2", pressed);
          }),
          () =>
            Effect.sync(() => {
              process.off("SIGUSR2", pressed);
            }),
        );
      }
      const shortcut = yield* Effect.acquireRelease(
        Effect.sync(() => new GlobalMiniShortcut(pressed)),
        (owner) => Effect.sync(() => owner.dispose()),
      );
      yield* Effect.sync(() => panel.start());
      const syncCommandKeymap = (state: CommandKeymapState) =>
        Effect.try({
          try: () => shortcut.sync(state),
          catch: (cause) => new MiniRuntimeError({ operation: "register-shortcut", cause }),
        });
      yield* syncCommandKeymap(initial.commandKeymap).pipe(
        Effect.catch((error) => Effect.logWarning("Could not register the Mini shortcut", error)),
      );
      return MiniRuntime.of({
        panel,
        restingCoverage: () => (screenLocked ? EMPTY_MINI_COVERAGE : panel.restingCoverage()),
        syncCommandKeymap,
        restoreCommandKeymap: (state) => syncCommandKeymap(state).pipe(Effect.asVoid),
        decorateKeymap: (state) => shortcut.decorate(state),
        withDialog: (senderId, open) => panel.withDialog(senderId, open),
      });
    }),
  );
