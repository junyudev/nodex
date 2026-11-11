import type { IpcMainInvokeEvent } from "electron";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { parseChromeControlSettingsAction } from "../../../shared/chrome-control-settings";
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

/** Settings projection and explicit Windows registration actions. */
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

    const authorize = (event: IpcMainInvokeEvent) =>
      Effect.try({
        try: () =>
          requireTrustedAppRendererSender(
            event,
            "Chrome control provider settings",
            config.rendererUrl,
          ),
        catch: (cause) =>
          new ChromeControlSettingsIpcError({ operation: "authorize-renderer", cause }),
      });
    yield* ipc.handleQuery("chrome-control-settings-get", (event) =>
      authorize(event).pipe(Effect.andThen(chrome.refresh)),
    );
    const update = chrome.updateWindowsRegistration;
    if (update) {
      yield* ipc.handlePlainCommand("chrome-control-settings-update", (event, input: unknown) =>
        authorize(event).pipe(
          Effect.andThen(
            Effect.try({
              try: () => parseChromeControlSettingsAction(input),
              catch: (cause) =>
                new ChromeControlSettingsIpcError({ operation: "parse-action", cause }),
            }),
          ),
          Effect.flatMap(update),
        ),
      );
    }

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
