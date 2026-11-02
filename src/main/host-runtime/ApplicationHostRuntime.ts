import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { app, nativeImage, systemPreferences } from "electron";
import { join, resolve } from "node:path";
import { MainConfig } from "../app/MainConfig";
import { getLogger } from "../logging/logger";

export interface ApplicationHostNativePort {
  readonly askForMicrophoneAccess: () => Promise<boolean>;
  readonly getMicrophoneAccessStatus: () => string;
  readonly setAppUserModelId: (id: string) => void;
  readonly setDevelopmentDockIcon: (path: string) => void;
  readonly setDefaultProtocolClient: (
    scheme: string,
    executablePath?: string,
    args?: readonly string[],
  ) => void;
}

export class ApplicationHostRuntimeError extends Schema.TaggedError<ApplicationHostRuntimeError>()(
  "ApplicationHostRuntimeError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export class ApplicationHostRuntime extends Context.Service<
  ApplicationHostRuntime,
  {
    readonly requestMicrophonePermission: Effect.Effect<void>;
  }
>()("nodex/main/host-runtime/ApplicationHostRuntime") {}

const electronNative = (): ApplicationHostNativePort => ({
  askForMicrophoneAccess: () => systemPreferences.askForMediaAccess("microphone"),
  getMicrophoneAccessStatus: () => systemPreferences.getMediaAccessStatus("microphone"),
  setAppUserModelId: (id) => app.setAppUserModelId(id),
  setDevelopmentDockIcon: (path) => {
    const icon = nativeImage.createFromPath(path);
    if (!icon.isEmpty()) app.dock?.setIcon(icon);
  },
  setDefaultProtocolClient: (scheme, executablePath, args) => {
    if (executablePath) {
      app.setAsDefaultProtocolClient(scheme, executablePath, [...(args ?? [])]);
      return;
    }
    app.setAsDefaultProtocolClient(scheme);
  },
});

export const live = (
  nativeOverride?: ApplicationHostNativePort,
): Layer.Layer<ApplicationHostRuntime, ApplicationHostRuntimeError, MainConfig> =>
  Layer.effect(
    ApplicationHostRuntime,
    Effect.gen(function* () {
      const config = yield* MainConfig;
      const native = nativeOverride ?? electronNative();
      const logger = getLogger({ component: "application-host-runtime" });

      yield* Effect.try({
        try: () => {
          if (config.platform === "win32") native.setAppUserModelId("app.jyu.nodex");

          const entry = config.argv[1];
          if (!config.isPackaged && config.isDefaultApp && entry) {
            native.setDefaultProtocolClient("nodex", config.runtimeBinaryPath, [resolve(entry)]);
          } else if (config.platform !== "win32" || !config.isPackaged) {
            native.setDefaultProtocolClient("nodex");
          }

          if (config.platform === "darwin" && !config.isPackaged) {
            native.setDevelopmentDockIcon(join(config.projectRootPath, "resources/icon.png"));
          }
        },
        catch: (cause) => new ApplicationHostRuntimeError({ operation: "configure-host", cause }),
      });

      const requestMicrophonePermission =
        config.platform !== "darwin" || native.getMicrophoneAccessStatus() === "granted"
          ? Effect.void
          : Effect.tryPromise({
              try: native.askForMicrophoneAccess,
              catch: (cause) =>
                new ApplicationHostRuntimeError({
                  operation: "request-microphone-permission",
                  cause,
                }),
            }).pipe(
              Effect.catch((error) =>
                Effect.sync(() =>
                  logger.warn("Could not request macOS microphone permission", { error }),
                ),
              ),
              Effect.asVoid,
            );

      return ApplicationHostRuntime.of({ requestMicrophonePermission });
    }),
  );
