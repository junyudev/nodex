import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { IpcMainInvokeEvent } from "electron";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { MainConfig } from "../../app/MainConfig";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import {
  openLoginItemSystemSettings,
  readOpenAtLogin,
  setOpenAtLogin,
} from "../../platform/electron/ElectronLoginItems";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";

class OpenAtLoginError extends Schema.TaggedError<OpenAtLoginError>()("OpenAtLoginError", {
  cause: Schema.Defect(),
}) {}

export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const ipc = yield* ElectronIpc;
    const windows = yield* WindowRuntime;
    const authorized = <A>(event: IpcMainInvokeEvent, run: () => A) =>
      Effect.try({
        try: () => {
          requireTrustedAppRendererSender(event, "Open at login", config.rendererUrl);
          if (!windows.has(event.sender.id)) {
            throw new Error("Open at login requires a Workbench window");
          }
          return run();
        },
        catch: (cause) => new OpenAtLoginError({ cause }),
      });

    yield* ipc.handleQuery("settings:open-at-login:get", (event) =>
      authorized(event, () => readOpenAtLogin(config)),
    );
    yield* ipc.handlePlainCommand("settings:open-at-login:set", (event, enabled: unknown) =>
      authorized(event, () => {
        if (typeof enabled !== "boolean") throw new TypeError("Expected a login item toggle");
        return setOpenAtLogin(config, enabled);
      }),
    );
    yield* ipc.handlePlainCommand("settings:open-at-login:open-system-settings", (event) =>
      authorized(event, () => undefined).pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: () => openLoginItemSystemSettings(config.platform),
            catch: (cause) => new OpenAtLoginError({ cause }),
          }),
        ),
      ),
    );
  }),
);
