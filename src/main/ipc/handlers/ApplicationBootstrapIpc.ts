import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import { APP_INITIALIZATION_STEP_CHANNEL, APP_RESTART_CHANNEL } from "../../../shared/app-startup";
import {
  WindowSessionBoundsSchema,
  WindowSessionSaveLayoutInputSchema,
} from "../../../shared/schemas/window-session";
import { MainConfig } from "../../app/MainConfig";
import { MainShutdown } from "../../app/MainShutdown";
import { ApplicationInitializationRuntime } from "../../host-runtime/ApplicationInitializationRuntime";
import { safeSendToWebContents } from "../../ipc-safe-send";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { ApplicationWindowShellRuntime } from "../../window-runtime/ApplicationWindowShellRuntime";
import { captureWindowSessionBounds, WindowRuntime } from "../../window-runtime/WindowRuntime";

export class ApplicationBootstrapIpcError extends Schema.TaggedError<ApplicationBootstrapIpcError>()(
  "ApplicationBootstrapIpcError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export class ApplicationBootstrapIpc extends Context.Service<
  ApplicationBootstrapIpc,
  Record<never, never>
>()("nodex/main/ipc/ApplicationBootstrapIpc") {}

const RendererInitializationReport = z
  .object({
    durationMs: z
      .number()
      .finite()
      .min(0)
      .max(10 * 60_000),
    outcome: z.enum(["ready", "failed"]),
  })
  .strict();

/** The complete pre-Core IPC authority exposed to the canonical application shell. */
export const live: Layer.Layer<
  ApplicationBootstrapIpc,
  never,
  | ApplicationInitializationRuntime
  | ApplicationWindowShellRuntime
  | ElectronIpc
  | MainConfig
  | MainShutdown
  | WindowRuntime
> = Layer.effect(
  ApplicationBootstrapIpc,
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const initialization = yield* ApplicationInitializationRuntime;
    const ipc = yield* ElectronIpc;
    const shutdown = yield* MainShutdown;
    const shell = yield* ApplicationWindowShellRuntime;
    const windows = yield* WindowRuntime;
    const authorize = (event: IpcMainEvent | IpcMainInvokeEvent, capabilityName: string) =>
      Effect.try({
        try: () => {
          requireTrustedAppRendererSender(event, capabilityName, config.rendererUrl);
          if (!windows.has(event.sender.id)) {
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

    yield* ipc.handleQuery("app:await-initialization", (event) =>
      authorize(event, "Application initialization").pipe(
        Effect.andThen(
          initialization.current.pipe(
            Effect.map((step) => {
              safeSendToWebContents(event.sender, APP_INITIALIZATION_STEP_CHANNEL, [step]);
            }),
          ),
        ),
        Effect.andThen(
          Effect.all([initialization.awaitDone, shell.awaitActivation(event.sender.id)], {
            discard: true,
          }),
        ),
      ),
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
    yield* ipc.handleQuery("window-sessions:bootstrap", (event) =>
      authorize(event, "Window Session bootstrap").pipe(
        Effect.andThen(
          parse("bootstrap-window-session", () => ({
            session: windows.bootstrap(event.sender.id),
          })),
        ),
      ),
    );
    yield* ipc.handlePlainCommand("window-sessions:save-layout", (event, input: unknown) =>
      authorize(event, "Window Session layout").pipe(
        Effect.andThen(
          parse("parse-window-layout", () => WindowSessionSaveLayoutInputSchema.parse(input)),
        ),
        Effect.flatMap((layout) =>
          parse("save-window-layout", () => {
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
