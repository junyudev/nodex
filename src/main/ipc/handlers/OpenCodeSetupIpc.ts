import type { IpcMainInvokeEvent } from "electron";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { MainConfig } from "../../app/MainConfig";
import { OpenCodeSetup } from "../../host-runtime/OpenCodeSetup";
import { safeBroadcastToWindows } from "../../ipc-safe-send";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

export class OpenCodeSetupIpcError extends Schema.TaggedError<OpenCodeSetupIpcError>()(
  "OpenCodeSetupIpcError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

/** The renderer can request setup; Main owns the command, host environment and process. */
export const live: Layer.Layer<
  never,
  never,
  OpenCodeSetup | ElectronIpc | MainConfig | WindowRuntime
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const setup = yield* OpenCodeSetup;
    const config = yield* MainConfig;
    const ipc = yield* ElectronIpc;
    const windows = yield* WindowRuntime;
    const trusted = (event: IpcMainInvokeEvent) =>
      Effect.try({
        try: () => requireTrustedAppRendererSender(event, "OpenCode setup", config.rendererUrl),
        catch: (cause) => new OpenCodeSetupIpcError({ operation: "authorize-renderer", cause }),
      });

    yield* ipc.handleQuery("opencode-setup:read", (event) =>
      trusted(event).pipe(Effect.andThen(setup.read)),
    );
    yield* ipc.handlePlainCommand("opencode-setup:install", (event) =>
      trusted(event).pipe(Effect.andThen(setup.install)),
    );
    yield* ipc.handlePlainCommand("opencode-setup:cancel", (event) =>
      trusted(event).pipe(Effect.andThen(setup.cancel)),
    );

    yield* setup.changes.pipe(
      Stream.runForEach((snapshot) =>
        Effect.sync(() => {
          safeBroadcastToWindows(windows.all(), "opencode-setup:changed", [snapshot]);
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
  }),
);
