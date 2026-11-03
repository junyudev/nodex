import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MainConfig } from "../../app/MainConfig";
import { WindowsTrayError, WindowsTrayRuntime } from "../../host-runtime/WindowsTrayRuntime";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import type { IpcMainInvokeEvent } from "electron";

export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const ipc = yield* ElectronIpc;
    const tray = yield* WindowsTrayRuntime;
    const authorize = (event: IpcMainInvokeEvent) =>
      Effect.try({
        try: () =>
          requireTrustedAppRendererSender(event, "Windows startup settings", config.rendererUrl),
        catch: (cause) => new WindowsTrayError({ operation: "authorize-startup-settings", cause }),
      });
    yield* ipc.handleQuery("windows-startup:status", (event) =>
      authorize(event).pipe(Effect.andThen(tray.startupStatus)),
    );
    yield* ipc.handlePlainCommand("windows-startup:open-settings", (event) =>
      authorize(event).pipe(Effect.andThen(tray.openStartupSettings)),
    );
  }),
);
