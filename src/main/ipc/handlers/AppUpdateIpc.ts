import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import { MainConfig } from "../../app/MainConfig";
import { AppUpdateRuntime } from "../../host-runtime/AppUpdateRuntime";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";

export class AppUpdateIpcError extends Schema.TaggedError<AppUpdateIpcError>()(
  "AppUpdateIpcError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

const UpdateAppSettings = z
  .object({
    automaticChecksEnabled: z.boolean().optional(),
    channel: z.enum(["stable", "nightly"]).optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).length > 0, "App update settings input is empty");

export const live: Layer.Layer<never, never, AppUpdateRuntime | ElectronIpc | MainConfig> =
  Layer.effectDiscard(
    Effect.gen(function* () {
      const appUpdates = yield* AppUpdateRuntime;
      const config = yield* MainConfig;
      const ipc = yield* ElectronIpc;
      const trusted = (event: IpcMainInvokeEvent, capabilityName: string) =>
        Effect.try({
          try: () => requireTrustedAppRendererSender(event, capabilityName, config.rendererUrl),
          catch: (cause) => new AppUpdateIpcError({ operation: "authorize-renderer", cause }),
        });

      yield* ipc.handleQuery("settings:app-updates:get", (event) =>
        trusted(event, "App update settings").pipe(Effect.andThen(appUpdates.currentSettings)),
      );
      yield* ipc.handlePlainCommand("settings:app-updates:update", (event, input: unknown) =>
        trusted(event, "App update settings").pipe(
          Effect.andThen(
            Effect.try({
              try: () => UpdateAppSettings.parse(input),
              catch: (cause) =>
                new AppUpdateIpcError({ operation: "parse-update-settings", cause }),
            }),
          ),
          Effect.flatMap(appUpdates.updateSettings),
        ),
      );
      yield* ipc.handleQuery("app:update:status", (event) =>
        trusted(event, "App update status").pipe(Effect.andThen(appUpdates.currentStatus)),
      );
      yield* ipc.handlePlainCommand("app:update:check", (event) =>
        trusted(event, "App update checks").pipe(Effect.andThen(appUpdates.check)),
      );
      yield* ipc.handlePlainCommand("app:update:install", (event) =>
        trusted(event, "App update installation").pipe(Effect.andThen(appUpdates.install)),
      );
    }),
  );
