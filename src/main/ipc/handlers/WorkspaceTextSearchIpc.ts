import type { IpcMainInvokeEvent } from "electron";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import {
  WorkspaceTextSearchStartSchema,
  WorkspaceTextSearchStopSchema,
} from "../../../shared/schemas/workspace-text-search";
import { MainConfig } from "../../app/MainConfig";
import { WorkspaceTextSearch } from "../../codex-application/WorkspaceTextSearch";
import { safeSendToWebContents } from "../../ipc-safe-send";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { textSearchError } from "../../platform/node/WorkspaceTextSearchPlatform";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

/** Each window owns its cancellable search fibers; closing the window releases every child process. */
export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const ipc = yield* ElectronIpc;
    const windows = yield* WindowRuntime;
    const search = yield* WorkspaceTextSearch;
    const lifetimes = yield* FiberMap.make<string>();
    const authorize = (event: IpcMainInvokeEvent) =>
      Effect.try({
        try: () => {
          requireTrustedAppRendererSender(event, "Workspace text search", config.rendererUrl);
          if (!windows.has(event.sender.id) || event.sender.isDestroyed())
            throw new Error("Search requires an active Nodex window");
        },
        catch: (cause) =>
          textSearchError("search-failed", "Search requires an active Nodex window", cause),
      });
    const parse = <A>(read: () => A) =>
      Effect.try({
        try: read,
        catch: (cause) => textSearchError("search-failed", "Invalid search request", cause),
      });
    yield* ipc.handleControl("workspace-text-search:start", (event, raw) =>
      authorize(event).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const request = yield* parse(() => WorkspaceTextSearchStartSchema.parse(raw));
            const destroyed = Effect.callback<never>((resume) => {
              if (event.sender.isDestroyed()) {
                resume(Effect.interrupt);
                return;
              }
              const onDestroyed = () => resume(Effect.interrupt);
              event.sender.once("destroyed", onDestroyed);
              return Effect.sync(() => event.sender.removeListener("destroyed", onDestroyed));
            });
            const emit = (notification: Parameters<Parameters<typeof search.search>[1]>[0]) =>
              Effect.sync(() => {
                safeSendToWebContents(event.sender, "workspace-text-search:event", [notification]);
              });
            yield* FiberMap.run(
              lifetimes,
              `${event.sender.id}\0${request.requestId}`,
              search.search(request, emit).pipe(
                Effect.catch((error) =>
                  emit({
                    requestId: request.requestId,
                    type: "error",
                    code: error.code,
                    message: error.message,
                  }),
                ),
                Effect.raceFirst(destroyed),
              ),
              { startImmediately: true },
            );
          }),
        ),
      ),
    );
    yield* ipc.handleControl("workspace-text-search:stop", (event, raw) =>
      authorize(event).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const request = yield* parse(() => WorkspaceTextSearchStopSchema.parse(raw));
            yield* FiberMap.remove(lifetimes, `${event.sender.id}\0${request.requestId}`);
          }),
        ),
      ),
    );
  }),
);
