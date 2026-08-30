import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { IpcMainInvokeEvent } from "electron";
import { MainConfig } from "../../app/MainConfig";
import { safeBroadcastToWindows } from "../../ipc-safe-send";
import { makePersistedAtomStore } from "../../local-store/persisted-atoms";
import { getLogger } from "../../logging/logger";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

export class ApplicationLocalStateIpcError extends Schema.TaggedError<ApplicationLocalStateIpcError>()(
  "ApplicationLocalStateIpcError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

const diagnostics = getLogger({ subsystem: "renderer", component: "diagnostics" });

export const live: Layer.Layer<never, never, ElectronIpc | MainConfig | WindowRuntime> =
  Layer.effectDiscard(
    Effect.gen(function* () {
      const config = yield* MainConfig;
      const persistedAtoms = makePersistedAtomStore(config.nodexHome);
      const ipc = yield* ElectronIpc;
      const windows = yield* WindowRuntime;
      const { handleControl, handleQuery, handleRevisionedCommand } = ipc;
      const authorize = (event: IpcMainInvokeEvent) =>
        Effect.try({
          try: () => {
            requireTrustedAppRendererSender(event, "Application local state", config.rendererUrl);
            if (!windows.has(event.sender.id)) {
              throw new Error("Application local state requires an active Nodex window");
            }
          },
          catch: (cause) =>
            new ApplicationLocalStateIpcError({ operation: "authorize-renderer", cause }),
        });

      yield* handleControl("diagnostics:renderer-log", (event, input) =>
        authorize(event).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (config.assistantStreamingDebug) diagnostics.info(input.message, input.fields);
            }),
          ),
        ),
      );
      yield* handleQuery("persisted-atom:sync-request", (event) =>
        authorize(event).pipe(Effect.andThen(Effect.sync(() => persistedAtoms.readSnapshot()))),
      );
      yield* handleRevisionedCommand("persisted-atom:update", (event, mutation) =>
        authorize(event).pipe(
          Effect.andThen(
            Effect.try({
              try: () => {
                const persistedEvent = persistedAtoms.commitMutation(
                  mutation,
                  String(event.sender.id),
                );
                safeBroadcastToWindows(windows.all(), "persisted-atom:updated", [persistedEvent]);
                return persistedEvent;
              },
              catch: (cause) =>
                new ApplicationLocalStateIpcError({ operation: "update-persisted-atom", cause }),
            }),
          ),
        ),
      );
    }),
  );
