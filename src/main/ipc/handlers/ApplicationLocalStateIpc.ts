import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { IpcMainInvokeEvent } from "electron";
import { CoreAuthority } from "../../core-runtime/CoreAuthority";
import { rendererSpaceParameter } from "../../../shared/space-ipc-policy";
import {
  personalStateKeyMatches,
  personalStateKeySpace,
} from "../../../shared/space-personal-state";
import { MainConfig } from "../../app/MainConfig";
import { RendererFrameHealthSchema } from "../../../shared/diagnostics/frame-health";
import { isDevRuntimeMetricsEnabled, logDevRuntimeMetric } from "../../dev-runtime-metrics";
import { safeBroadcastToWindows } from "../../ipc-safe-send";
import { ProfilePersistedAtoms } from "../../local-store/ProfilePersistedAtoms";
import { getLogger } from "../../logging/logger";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

export class ApplicationLocalStateIpcError extends Schema.TaggedError<ApplicationLocalStateIpcError>()(
  "ApplicationLocalStateIpcError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

const diagnostics = getLogger({ subsystem: "renderer", component: "diagnostics" });

export const live: Layer.Layer<
  never,
  never,
  ElectronIpc | MainConfig | WindowRuntime | ProfilePersistedAtoms | CoreAuthority
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const authority = yield* CoreAuthority;
    const senderSpace = (url: string) =>
      rendererSpaceParameter(url) ?? authority.identity.libraryId;
    const persistedAtoms = yield* ProfilePersistedAtoms;
    const ipc = yield* ElectronIpc;
    const windows = yield* WindowRuntime;
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        persistedAtoms.subscribe((event) => {
          const owner = personalStateKeySpace(event.key);
          safeBroadcastToWindows(
            windows
              .appRenderers()
              .filter(
                (window) =>
                  owner === null || senderSpace(window.webContents.getURL?.() ?? "") === owner,
              ),
            "persisted-atom:updated",
            [event],
          );
        }),
      ),
      (unsubscribe) => Effect.sync(unsubscribe),
    );
    const { handleControl, handleQuery, handleRevisionedCommand } = ipc;
    const authorize = (event: IpcMainInvokeEvent, allowMini = false) =>
      Effect.try({
        try: () => {
          requireTrustedAppRendererSender(event, "Application local state", config.rendererUrl);
          if (
            !(allowMini ? windows.hasAppRenderer(event.sender.id) : windows.has(event.sender.id))
          ) {
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
    yield* handleControl("diagnostics:renderer-frames", (event, input) =>
      authorize(event).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (!isDevRuntimeMetricsEnabled()) return;
            const frames = RendererFrameHealthSchema.safeParse(input);
            if (frames.success)
              logDevRuntimeMetric("renderer.frames", { window: event.sender.id, ...frames.data });
          }),
        ),
      ),
    );
    yield* handleQuery("persisted-atom:sync-request", (event) =>
      authorize(event, true).pipe(
        Effect.andThen(
          Effect.sync(() => {
            const snapshot = persistedAtoms.readSnapshot();
            const spaceId = senderSpace(event.senderFrame?.url ?? "");
            return {
              ...snapshot,
              values: Object.fromEntries(
                Object.entries(snapshot.values).filter(([key]) =>
                  personalStateKeyMatches(key, spaceId),
                ),
              ),
            };
          }),
        ),
      ),
    );
    yield* handleRevisionedCommand("persisted-atom:update", (event, mutation) =>
      authorize(event, true).pipe(
        Effect.andThen(
          Effect.try({
            try: () => {
              if (!personalStateKeyMatches(mutation.key, senderSpace(event.senderFrame?.url ?? "")))
                throw new Error("Personal state belongs to another Space");
              return persistedAtoms.commitMutation(mutation, String(event.sender.id));
            },
            catch: (cause) =>
              new ApplicationLocalStateIpcError({ operation: "update-persisted-atom", cause }),
          }),
        ),
        // The window counts its change as saved only once it is on disk.
        Effect.tap((persistedEvent) =>
          Effect.tryPromise({
            try: () => persistedAtoms.whenDurable(persistedEvent.revision),
            catch: (cause) =>
              new ApplicationLocalStateIpcError({ operation: "save-persisted-atom", cause }),
          }),
        ),
      ),
    );
  }),
);
