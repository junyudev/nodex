import type { IpcMainInvokeEvent } from "electron";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ProviderKeyIdInputSchema } from "../../../shared/provider-keys";
import { rendererSpaceParameter } from "../../../shared/space-ipc-policy";
import { MainConfig } from "../../app/MainConfig";
import { isTrustedAppRendererIpcSender } from "../../app-renderer-ipc-authorization";
import { safeBroadcastToPersonalWindows } from "../../ipc-safe-send";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { ProviderKeyUsage } from "../../provider-keys/ProviderKeyUsage";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const usage = yield* ProviderKeyUsage;
    const ipc = yield* ElectronIpc;
    const config = yield* MainConfig;
    const windows = yield* WindowRuntime;

    const authorize = (event: IpcMainInvokeEvent) =>
      Effect.suspend(() => {
        const senderUrl = event.senderFrame?.url ?? "";
        const trusted = isTrustedAppRendererIpcSender({
          developmentOrigin: config.rendererUrl,
          hasOwnerWindow: windows.has(event.sender.id),
          senderType: event.sender.getType(),
          senderUrl,
          isMainFrame: event.senderFrame === event.sender.mainFrame,
        });
        return trusted && rendererSpaceParameter(senderUrl) === null
          ? Effect.void
          : Effect.fail(new Error("API key usage requires a personal Nodex window."));
      });

    yield* usage.changes.pipe(
      Stream.runForEach((snapshot) =>
        Effect.sync(() => {
          safeBroadcastToPersonalWindows(windows.all(), "provider-keys:usage-changed", [snapshot]);
        }),
      ),
      Effect.forkScoped,
    );
    yield* ipc.handleQuery("provider-keys:usage:read", (event) =>
      authorize(event).pipe(Effect.andThen(usage.read)),
    );
    yield* ipc.handleQuery("provider-keys:usage:refresh", (event, connectionId) =>
      authorize(event).pipe(
        Effect.flatMap(() => {
          if (connectionId === undefined) return usage.refresh();
          const input = ProviderKeyIdInputSchema.safeParse({ id: connectionId });
          return input.success
            ? usage.refresh(input.data.id)
            : Effect.fail(new Error("Choose an API key connection to refresh."));
        }),
      ),
    );
  }),
);
