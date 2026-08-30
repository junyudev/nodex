import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { IpcMainInvokeEvent } from "electron";
import { MainConfig } from "../../app/MainConfig";
import { ComposerAppshotRuntime } from "../../host-runtime/ComposerAppshotRuntime";
import { ElectronIpc, mapElectronIpcHandlers } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

export class ComposerAppshotIpcError extends Schema.TaggedError<ComposerAppshotIpcError>()(
  "ComposerAppshotIpcError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export const live: Layer.Layer<
  never,
  never,
  ComposerAppshotRuntime | ElectronIpc | MainConfig | WindowRuntime
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const appshots = yield* ComposerAppshotRuntime;
    const config = yield* MainConfig;
    const ipc = yield* ElectronIpc;
    const windows = yield* WindowRuntime;
    const authorize = (event: IpcMainInvokeEvent) =>
      Effect.try({
        try: () => {
          requireTrustedAppRendererSender(event, "Composer Appshot", config.rendererUrl);
          if (!windows.has(event.sender.id)) {
            throw new Error("Composer Appshot requires an active Nodex window");
          }
        },
        catch: (cause) => new ComposerAppshotIpcError({ operation: "authorize-renderer", cause }),
      });
    const { handlePlainCommand, handleQuery } = mapElectronIpcHandlers(
      ipc,
      (_channel, handler) =>
        (event, ...args) =>
          authorize(event).pipe(Effect.andThen(handler(event, ...args))),
    );

    yield* handleQuery("codex:composer-appshot:target", () => appshots.readTarget);
    yield* handlePlainCommand("codex:composer-appshot:capture", (_event, input) => {
      if (
        typeof input !== "object" ||
        input === null ||
        typeof input.targetId !== "string" ||
        !input.targetId.trim() ||
        input.targetId.length > 512
      ) {
        return Effect.fail(
          new ComposerAppshotIpcError({
            operation: "validate-capture-target",
            cause: new Error("Invalid Appshot capture target"),
          }),
        );
      }
      return appshots.capture(input.targetId.trim());
    });
  }),
);
