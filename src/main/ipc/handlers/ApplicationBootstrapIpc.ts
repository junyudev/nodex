import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import {
  APP_INITIALIZATION_STEP_CHANNEL,
  APP_RESTART_CHANNEL,
  RENDERER_INITIALIZATION_PHASES,
  type AppRendererBootstrap,
} from "../../../shared/app-startup";
import { parseDevelopmentFeatureEnvironment } from "../../../shared/development-features";
import {
  FAIL_CLOSED_RUNTIME_CAPABILITIES,
  type AppRuntimeCapabilities,
} from "../../../shared/runtime-capabilities";
import {
  WindowSessionBoundsSchema,
  WindowSessionSaveLayoutInputSchema,
} from "../../../shared/schemas/window-session";
import { rendererSpaceParameter } from "../../../shared/space-ipc-policy";
import { MainObservability } from "../../app/MainObservability";
import { MainConfig } from "../../app/MainConfig";
import { MainShutdown } from "../../app/MainShutdown";
import { ApplicationInitializationRuntime } from "../../host-runtime/ApplicationInitializationRuntime";
import { safeSendToWebContents } from "../../ipc-safe-send";
import { getMainLanguageSettings } from "../../i18n/main-intl";
import { ElectronIpc, ElectronSpaceIpc } from "../../platform/electron/ElectronIpc";
import { ApplicationSettings } from "../../settings/ApplicationSettings";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { ApplicationWindowShellRuntime } from "../../window-runtime/ApplicationWindowShellRuntime";
import { captureWindowSessionBounds, WindowRuntime } from "../../window-runtime/WindowRuntime";

export class ApplicationBootstrapIpcError extends Schema.TaggedError<ApplicationBootstrapIpcError>()(
  "ApplicationBootstrapIpcError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export class ApplicationBootstrapIpc extends Context.Service<
  ApplicationBootstrapIpc,
  Record<string, never>
>()("nodex/main/ipc/ApplicationBootstrapIpc") {}

const RendererInitializationReport = z
  .object({
    durationMs: z
      .number()
      .finite()
      .min(0)
      .max(10 * 60_000),
    outcome: z.enum(["ready", "failed"]),
    timingsMs: z
      .partialRecord(
        z.enum(RENDERER_INITIALIZATION_PHASES),
        z
          .number()
          .finite()
          .min(0)
          .max(10 * 60_000),
      )
      .optional(),
  })
  .strict();

/** The complete pre-Core IPC authority exposed to the canonical application shell. */
export const live: Layer.Layer<
  ApplicationBootstrapIpc,
  never,
  | ApplicationInitializationRuntime
  | ApplicationSettings
  | ApplicationWindowShellRuntime
  | ElectronIpc
  | ElectronSpaceIpc
  | MainConfig
  | MainObservability
  | MainShutdown
  | WindowRuntime
> = Layer.effect(
  ApplicationBootstrapIpc,
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const observability = yield* MainObservability;
    const initialization = yield* ApplicationInitializationRuntime;
    const ipc = yield* ElectronIpc;
    const spaces = yield* ElectronSpaceIpc;
    const settings = yield* ApplicationSettings;
    const shutdown = yield* MainShutdown;
    const shell = yield* ApplicationWindowShellRuntime;
    const windows = yield* WindowRuntime;
    const runtimeCapabilities = yield* Effect.try((): AppRuntimeCapabilities => ({
      enabledDevelopmentFeatures: [...parseDevelopmentFeatureEnvironment(config.environment)],
    })).pipe(Effect.orElseSucceed(() => FAIL_CLOSED_RUNTIME_CAPABILITIES));
    const authorize = (
      event: IpcMainEvent | IpcMainInvokeEvent,
      capabilityName: string,
      allowMini = false,
    ) =>
      Effect.try({
        try: () => {
          requireTrustedAppRendererSender(event, capabilityName, config.rendererUrl);
          if (
            !(allowMini ? windows.hasAppRenderer(event.sender.id) : windows.has(event.sender.id))
          ) {
            throw new Error(`${capabilityName} requires an active Nodex window`);
          }
        },
        catch: (cause) =>
          new ApplicationBootstrapIpcError({ operation: "authorize-renderer", cause }),
      });
    const parse = <A>(operation: string, decode: () => A) =>
      Effect.try({
        try: decode,
        catch: (cause) => new ApplicationBootstrapIpcError({ operation, cause }),
      });

    yield* ipc.handleQuery("settings:language:get", (event) =>
      parse("read-language-settings", () => {
        requireTrustedAppRendererSender(event, "Language settings", config.rendererUrl);
        return getMainLanguageSettings();
      }),
    );
    yield* ipc.handleQuery("app:startup-failure-evidence", (event) =>
      authorize(event, "Startup failure evidence").pipe(
        Effect.andThen(observability.startupFailureEvidence),
      ),
    );
    // One reply carries everything the renderer needs to start, so a window binds and mounts
    // after a single round trip rather than a chain of dependent reads.
    const rendererBootstrap = (event: IpcMainInvokeEvent, mini: boolean) =>
      Effect.all(
        {
          space: spaces.context(event),
          diagnostics: settings.snapshot().pipe(
            Effect.map((snapshot) => snapshot.diagnostics),
            Effect.orElseSucceed(() => null),
          ),
        },
        { concurrency: "unbounded" },
      ).pipe(
        Effect.flatMap((base) => {
          if (mini)
            return Effect.succeed<AppRendererBootstrap>({
              ...base,
              runtimeCapabilities,
              kind: "mini",
            });
          return parse("bootstrap-window-session", () => ({
            ...base,
            runtimeCapabilities,
            kind: "window-session" as const,
            windowSession: windows.bootstrap(
              event.sender.id,
              rendererSpaceParameter(event.senderFrame?.url ?? ""),
            ),
          }));
        }),
      );
    yield* ipc.handleQuery("app:await-initialization", (event) =>
      Effect.gen(function* () {
        yield* authorize(event, "Application initialization", true);
        const mini = windows.hasAuxiliaryRole(event.sender.id, "mini");
        const step = yield* initialization.current;
        safeSendToWebContents(event.sender, APP_INITIALIZATION_STEP_CHANNEL, [step]);
        yield* Effect.all(
          [initialization.awaitDone, mini ? Effect.void : shell.awaitActivation(event.sender.id)],
          { discard: true },
        );
        return yield* rendererBootstrap(event, mini);
      }),
    );
    yield* ipc.on("app:renderer-initialization-finished", (event, input: unknown) =>
      authorize(event, "Renderer initialization report").pipe(
        Effect.andThen(
          Effect.try({
            try: () => RendererInitializationReport.parse(input),
            catch: (cause) =>
              new ApplicationBootstrapIpcError({
                operation: "parse-renderer-initialization",
                cause,
              }),
          }),
        ),
        Effect.flatMap((report) =>
          initialization
            .reportRenderer(event.sender.id, report)
            .pipe(Effect.map((accepted) => ({ accepted, report }))),
        ),
        Effect.tap(({ accepted, report }) =>
          Effect.sync(() => {
            if (!accepted) return;
            if (report.outcome === "failed") {
              shell.failActivation(event.sender.id, new Error("Renderer initialization failed"));
              return;
            }
            shell.reportRenderer(event.sender.id);
          }),
        ),
        Effect.catch(() => Effect.void),
      ),
    );
    yield* ipc.handlePlainCommand("window-sessions:save-layout", (event, input: unknown) =>
      authorize(event, "Window Session layout").pipe(
        Effect.andThen(
          parse("parse-window-layout", () => WindowSessionSaveLayoutInputSchema.parse(input)),
        ),
        Effect.flatMap((layout) =>
          parse("save-window-layout", () => {
            const spaceId = rendererSpaceParameter(event.senderFrame?.url ?? "");
            if (layout.spaceId !== spaceId)
              throw new Error("Window Session layout requires its sending Space");
            const window = windows.get(event.sender.id);
            const bounds =
              window && !window.isDestroyed() ? captureWindowSessionBounds(window) : undefined;
            return { session: windows.saveLayout(event.sender.id, layout, bounds) };
          }),
        ),
      ),
    );
    yield* ipc.handlePlainCommand("window-sessions:update-bounds", (event, input: unknown) =>
      authorize(event, "Window Session bounds").pipe(
        Effect.andThen(
          parse("parse-window-bounds", () => WindowSessionBoundsSchema.strict().parse(input)),
        ),
        Effect.tap((bounds) => Effect.sync(() => windows.updateBounds(event.sender.id, bounds))),
        Effect.asVoid,
      ),
    );
    yield* ipc.handleControl(
      "app:flush-before-close:done",
      (event, claimedWebContentsId: unknown) =>
        authorize(event, "Window close flush").pipe(
          Effect.andThen(
            Effect.try({
              try: () => {
                if (claimedWebContentsId !== event.sender.id) {
                  throw new Error("Window close flush sender does not own the claimed window");
                }
                windows.acknowledgeClose(event.sender.id);
              },
              catch: (cause) =>
                new ApplicationBootstrapIpcError({ operation: "acknowledge-window-close", cause }),
            }),
          ),
        ),
    );
    yield* ipc.handlePlainCommand(APP_RESTART_CHANNEL, (event) =>
      authorize(event, "Application restart").pipe(
        Effect.andThen(shutdown.request({ _tag: "StartupFailure" })),
        Effect.asVoid,
      ),
    );
    return ApplicationBootstrapIpc.of({});
  }),
);
