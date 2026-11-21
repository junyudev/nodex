import type { IpcMainInvokeEvent } from "electron";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { AgentRuntimeAntigravityInstallation } from "../../agent-runtime/AgentRuntimeAntigravityInstallation";
import { MainConfig } from "../../app/MainConfig";
import { safeBroadcastToPersonalWindows } from "../../ipc-safe-send";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const runtime = yield* AgentRuntimeAntigravityInstallation;
    const config = yield* MainConfig;
    const ipc = yield* ElectronIpc;
    const windows = yield* WindowRuntime;
    const trusted = (event: IpcMainInvokeEvent) =>
      Effect.try(() =>
        requireTrustedAppRendererSender(event, "Antigravity runtime", config.rendererUrl),
      );

    yield* ipc.handleQuery("antigravity-runtime:read", (event) =>
      trusted(event).pipe(Effect.andThen(runtime.read)),
    );
    yield* ipc.handleQuery("antigravity-runtime:check", (event) =>
      trusted(event).pipe(Effect.andThen(runtime.check)),
    );
    yield* ipc.handlePlainCommand("antigravity-runtime:start", (event) =>
      trusted(event).pipe(Effect.andThen(runtime.start)),
    );
    yield* ipc.handlePlainCommand("antigravity-runtime:remove", (event) =>
      trusted(event).pipe(Effect.andThen(runtime.remove)),
    );
    yield* ipc.handleQuery("antigravity-runtime:operation:read", (event, id) =>
      trusted(event).pipe(Effect.andThen(runtime.readOperation(id))),
    );
    yield* ipc.handlePlainCommand("antigravity-runtime:operation:cancel", (event, id) =>
      trusted(event).pipe(Effect.andThen(runtime.cancel(id))),
    );
    yield* runtime.changes.pipe(
      Stream.runForEach((snapshot) =>
        Effect.sync(() => {
          safeBroadcastToPersonalWindows(windows.all(), "antigravity-runtime:changed", [snapshot]);
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
  }),
);
