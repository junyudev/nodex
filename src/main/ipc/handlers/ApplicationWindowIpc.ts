import { z } from "zod";
import { setWindowShellZoom, syncWindowNavigationChrome } from "../../window-navigation-chrome";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { nativeTheme, type IpcMainInvokeEvent } from "electron";
import type { WindowSessionNewWindowRequest } from "../../../shared/window-session";
import type { WorkbenchPageStageSurfaceConfig } from "../../../shared/workbench-scene";
import { rendererSpaceParameter } from "../../../shared/space-ipc-policy";
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
  readonly validatePageTarget: (
    event: IpcMainInvokeEvent,
    page: WorkbenchPageStageSurfaceConfig,
    destination: WindowSessionNewWindowRequest["pageDestination"],
  ) => Effect.Effect<void, unknown>;
}

export const live = (
  options: ApplicationWindowIpcOptions,
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

      yield* ipc.handleQuery("application-menu:snapshot", (event) =>
        authorize(event, "Application menu").pipe(Effect.andThen(menu.snapshot(event.sender.id))),
      );
      yield* ipc.handlePlainCommand("application-menu:invoke", (event, input: unknown) =>
        authorize(event, "Application menu").pipe(
          Effect.andThen(parse("parse-menu-item", () => z.string().min(1).max(128).parse(input))),
          Effect.flatMap((id) => menu.invoke(event.sender.id, id)),
        ),
      );
      yield* ipc.handlePlainCommand("window:appearance:sync", (event, input: unknown) =>
        authorize(event, "Window appearance").pipe(
          Effect.andThen(
            parse("parse-window-appearance", () =>
              z
                .object({
                  theme: z.enum(["light", "dark", "system"]),
                  shellZoom: z.number().min(0.1).max(10),
                })
                .strict()
                .parse(input),
            ),
          ),
          Effect.tap((appearance) =>
            Effect.sync(() => {
              const window = windows.get(event.sender.id);
              if (!window) return;
              setWindowShellZoom(window, appearance.shellZoom);
              nativeTheme.themeSource = appearance.theme;
              syncWindowNavigationChrome(
                window,
                config.platform as NodeJS.Platform,
                nativeTheme.shouldUseDarkColors,
              );
            }),
          ),
          Effect.asVoid,
        ),
      );
      yield* ipc.handleQuery("electron-window:fullscreen:get", (event) =>
        authorize(event, "Window fullscreen").pipe(
          Effect.andThen(Effect.sync(() => windows.get(event.sender.id)?.isFullScreen() ?? false)),
        ),
      );
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
      yield* ipc.handlePlainCommand("window:new", (event, input: unknown = {}) =>
        authorize(event, "New window").pipe(
          Effect.andThen(
            parse("parse-new-window", () => WindowSessionNewWindowRequestSchema.parse(input)),
          ),
          Effect.flatMap((request) => {
            const open = () => applicationWindows.openForRequest(event.sender.id, request);
            if (!request.page) return parse("open-new-window", open);

            const generation = windows.resolveRendererGeneration(event.sender.id);
            const spaceId = rendererSpaceParameter(event.senderFrame?.url ?? "");
            return options.validatePageTarget(event, request.page, request.pageDestination).pipe(
              Effect.andThen(
                parse("open-new-page-window", () => {
                  if (
                    generation === null ||
                    windows.resolveRendererGeneration(event.sender.id) !== generation ||
                    (windows.bootstrap(event.sender.id).activeSpaceId ?? null) !== spaceId
                  ) {
                    throw new Error("The source window changed while opening this Page");
                  }
                  open();
                }),
              ),
            );
          }),
          Effect.as(true),
        ),
      );
    }),
  );
