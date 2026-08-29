import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { IpcMainInvokeEvent } from "electron";

import type { IpcApi } from "../../../shared/ipc-api";
import { MainConfig } from "../../app/MainConfig";
import { RendererClientRuntime } from "../../host-runtime/RendererClientRuntime";
import { StructuralClipboardRuntime } from "../../host-runtime/StructuralClipboardRuntime";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

export class StructuralClipboardIpcError extends Schema.TaggedError<StructuralClipboardIpcError>()(
  "StructuralClipboardIpcError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

type StructuralChannel =
  | "clipboard:structural-begin"
  | "clipboard:structural-publish"
  | "clipboard:structural-settle"
  | "clipboard:structural-await";

type Handler<Channel extends StructuralChannel> = (
  event: IpcMainInvokeEvent,
  ...args: IpcApi[Channel]["args"]
) => Effect.Effect<IpcApi[Channel]["result"], unknown>;

/** Trusted IPC adapter for the Main-owned structural clipboard lifecycle. */
export const live: Layer.Layer<
  never,
  never,
  ElectronIpc | MainConfig | RendererClientRuntime | StructuralClipboardRuntime | WindowRuntime
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const ipc = yield* ElectronIpc;
    const rendererClients = yield* RendererClientRuntime;
    const structuralClipboard = yield* StructuralClipboardRuntime;
    const windows = yield* WindowRuntime;
    const handle = <Channel extends StructuralChannel>(
      channel: Channel,
      handler: Handler<Channel>,
    ) => ipc.handle(channel, handler);
    const authorize = (event: IpcMainInvokeEvent) =>
      Effect.try({
        try: () => {
          requireTrustedAppRendererSender(event, "Structural clipboard", config.rendererUrl);
          if (!windows.has(event.sender.id)) {
            throw new Error("Structural clipboard access requires an active Nodex window");
          }
          return rendererClients.ensureClient(event.sender).clientId;
        },
        catch: (cause) =>
          new StructuralClipboardIpcError({ operation: "authorize-renderer", cause }),
      });
    const interruptWhenRendererIsDestroyed = <A, E, R>(
      event: IpcMainInvokeEvent,
      operation: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> =>
      Effect.raceFirst(
        operation,
        Effect.callback<never>((resume) => {
          if (event.sender.isDestroyed()) {
            resume(Effect.interrupt);
            return;
          }
          const interrupt = (): void => resume(Effect.interrupt);
          event.sender.once("destroyed", interrupt);
          return Effect.sync(() => event.sender.removeListener("destroyed", interrupt));
        }),
      );

    yield* handle("clipboard:structural-begin", (event, input) =>
      authorize(event).pipe(
        Effect.flatMap((clientId) => structuralClipboard.begin(input, clientId)),
      ),
    );
    yield* handle("clipboard:structural-publish", (event, input) =>
      authorize(event).pipe(
        Effect.flatMap((clientId) => structuralClipboard.publish(input, clientId)),
      ),
    );
    yield* handle("clipboard:structural-settle", (event, input) =>
      authorize(event).pipe(
        Effect.flatMap((clientId) => structuralClipboard.settle(input, clientId)),
      ),
    );
    yield* handle("clipboard:structural-await", (event, input) =>
      authorize(event).pipe(
        Effect.flatMap(() =>
          interruptWhenRendererIsDestroyed(event, structuralClipboard.awaitResolution(input)),
        ),
      ),
    );
  }),
);
