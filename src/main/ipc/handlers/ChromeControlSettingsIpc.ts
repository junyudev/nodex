import type { IpcMainInvokeEvent } from "electron";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { MainConfig } from "../../app/MainConfig";
import { ChromeControlRuntime } from "../../host-runtime/ChromeControlRuntime";
import { safeSendToWindow } from "../../ipc-safe-send";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

export class ChromeControlSettingsIpcError extends Schema.TaggedError<ChromeControlSettingsIpcError>()(
  "ChromeControlSettingsIpcError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

/** Read-only settings projection; provider installation and repair remain Main-owned. */
export const live: Layer.Layer<
  never,
  never,
  ChromeControlRuntime | ElectronIpc | MainConfig | WindowRuntime
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const chrome = yield* ChromeControlRuntime;
    const config = yield* MainConfig;
    const ipc = yield* ElectronIpc;
    const windows = yield* WindowRuntime;

    yield* ipc.handleQuery("chrome-control-settings-get", (event: IpcMainInvokeEvent) =>
      Effect.try({
        try: () =>
          requireTrustedAppRendererSender(
            event,
            "Chrome control provider settings",
            config.rendererUrl,
          ),
        catch: (cause) =>
          new ChromeControlSettingsIpcError({ operation: "authorize-renderer", cause }),
      }).pipe(Effect.andThen(chrome.refresh)),
    );

    yield* chrome.changes.pipe(
      Stream.runForEach((change) =>
        Effect.sync(() => {
          for (const window of windows.all()) {
            safeSendToWindow(window, "chrome-control-settings-changed", [change.snapshot]);
          }
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
  }),
);
