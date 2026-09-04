import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { app, type IpcMainInvokeEvent } from "electron";
import { parseDevelopmentFeatureEnvironment } from "../../../shared/development-features";
import type { AppRuntimeCapabilities } from "../../../shared/runtime-capabilities";
import { WindowSessionNewWindowRequestSchema } from "../../../shared/schemas/window-session";
import { isTrustedAppRendererIpcSender } from "../../app-renderer-ipc-authorization";
import { MainConfig } from "../../app/MainConfig";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { ApplicationWindowRuntime } from "../../window-runtime/ApplicationWindowRuntime";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { ApplicationMenuRuntime } from "../../host-runtime/ApplicationMenuRuntime";
import { FocusedHistoryPublicationSchema } from "../../../shared/schemas/surface-history";

export class ApplicationWindowIpcError extends Schema.TaggedError<ApplicationWindowIpcError>()(
  "ApplicationWindowIpcError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export interface ApplicationWindowIpcOptions {
  readonly showEmojiPanel?: () => boolean;
  readonly runtimeCapabilities?: AppRuntimeCapabilities;
}

export const live = (
  options: ApplicationWindowIpcOptions = {},
): Layer.Layer<
  never,
  never,
  ApplicationWindowRuntime | ApplicationMenuRuntime | ElectronIpc | MainConfig | WindowRuntime
> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const applicationWindows = yield* ApplicationWindowRuntime;
      const config = yield* MainConfig;
      const ipc = yield* ElectronIpc;
      const windows = yield* WindowRuntime;
      const menu = yield* ApplicationMenuRuntime;
      const runtimeCapabilities =
        options.runtimeCapabilities ??
        (() => {
          try {
            return {
              enabledDevelopmentFeatures: [...parseDevelopmentFeatureEnvironment(process.env)],
            } satisfies AppRuntimeCapabilities;
          } catch {
            return { enabledDevelopmentFeatures: [] } satisfies AppRuntimeCapabilities;
          }
        })();
      const authorize = (event: IpcMainInvokeEvent, capability: string) =>
        Effect.try({
          try: () => {
            if (
              !isTrustedAppRendererIpcSender({
                developmentOrigin: config.rendererUrl,
                hasOwnerWindow: windows.has(event.sender.id),
                senderType: event.sender.getType(),
                senderUrl: event.senderFrame?.url ?? "",
                isMainFrame: event.senderFrame === event.sender.mainFrame,
              })
            ) {
              throw new Error(`${capability} requires an active Nodex window`);
            }
          },
          catch: (cause) =>
            new ApplicationWindowIpcError({ operation: "authorize-renderer", cause }),
        });
      const parse = <A>(operation: string, decode: () => A) =>
        Effect.try({
          try: decode,
          catch: (cause) => new ApplicationWindowIpcError({ operation, cause }),
        });

      yield* ipc.handleQuery("electron-window:focus:get", (event) =>
        authorize(event, "Window focus state").pipe(
          Effect.andThen(Effect.sync(() => windows.get(event.sender.id)?.isFocused() ?? false)),
        ),
      );
      yield* ipc.handleControl("surface-history:bind", (event) =>
        authorize(event, "Surface history observation").pipe(
          Effect.andThen(menu.bindHistory(event.sender.id)),
        ),
      );
      yield* ipc.handleControl("surface-history:publish", (event, input: unknown) =>
        authorize(event, "Surface history observation").pipe(
          Effect.andThen(
            parse("parse-history-publication", () => FocusedHistoryPublicationSchema.parse(input)),
          ),
          Effect.flatMap((publication) => menu.publishHistory(event.sender.id, publication)),
        ),
      );
      yield* ipc.handleQuery("app:runtime-capabilities:get", (event) =>
        authorize(event, "Runtime capabilities").pipe(Effect.as(runtimeCapabilities)),
      );
      yield* ipc.handlePlainCommand("window:show-emoji-panel", (event) =>
        authorize(event, "Emoji panel").pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (options.showEmojiPanel) return options.showEmojiPanel();
              if (config.platform !== "darwin") return false;
              app.showEmojiPanel();
              return true;
            }),
          ),
        ),
      );
      yield* ipc.handlePlainCommand("window:new", (event, input: unknown = {}) =>
        authorize(event, "New window").pipe(
          Effect.andThen(
            parse("parse-new-window", () => WindowSessionNewWindowRequestSchema.parse(input)),
          ),
          Effect.tap((request) =>
            Effect.sync(() => applicationWindows.openForRequest(event.sender.id, request)),
          ),
          Effect.as(true),
        ),
      );
    }),
  );
