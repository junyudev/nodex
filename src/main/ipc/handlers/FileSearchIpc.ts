import { randomUUID } from "node:crypto";
import type { IpcMainInvokeEvent } from "electron";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  FileSearchStartSchema,
  FileSearchStopSchema,
  FileSearchUpdateSchema,
} from "../../../shared/schemas/file-search";
import { MainConfig } from "../../app/MainConfig";
import { makeFileSearchSession, type FileSearchSession } from "../../codex-application/FileSearch";
import { CodexGateway } from "../../codex-runtime/CodexGateway";
import { safeSendToWebContents } from "../../ipc-safe-send";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

export class FileSearchIpcError extends Schema.TaggedError<FileSearchIpcError>()(
  "FileSearchIpcError",
  {
    cause: Schema.Defect(),
  },
) {}

/** Session controls are renderer-owned subscriptions, never filesystem work on Electron Main. */
export const live: Layer.Layer<
  never,
  never,
  ElectronIpc | MainConfig | WindowRuntime | CodexGateway
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const ipc = yield* ElectronIpc;
    const windows = yield* WindowRuntime;
    const gateway = yield* CodexGateway;
    const lifetimes = yield* FiberMap.make<string>();
    const sessions = new Map<string, FileSearchSession>();
    const keyFor = (event: IpcMainInvokeEvent, sessionId: string) =>
      `${event.sender.id}\0${sessionId}`;
    const authorize = (event: IpcMainInvokeEvent) =>
      Effect.try({
        try: () => {
          requireTrustedAppRendererSender(event, "File search", config.rendererUrl);
          if (!windows.has(event.sender.id) || event.sender.isDestroyed())
            throw new Error("File search requires an active Nodex window");
        },
        catch: (cause) => new FileSearchIpcError({ cause }),
      });
    const parse = <A>(read: () => A) =>
      Effect.try({ try: read, catch: (cause) => new FileSearchIpcError({ cause }) });

    yield* ipc.handleControl("file-search:start", (event, raw) =>
      authorize(event).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const input = yield* parse(() => FileSearchStartSchema.parse(raw));
            const key = keyFor(event, input.sessionId);
            const ready = yield* Deferred.make<void, FileSearchIpcError>();
            const destroyed = Effect.callback<never>((resume) => {
              if (event.sender.isDestroyed()) {
                resume(Effect.interrupt);
                return;
              }
              const onDestroyed = () => resume(Effect.interrupt);
              event.sender.once("destroyed", onDestroyed);
              return Effect.sync(() => event.sender.removeListener("destroyed", onDestroyed));
            });
            const lifecycle = Effect.scoped(
              Effect.gen(function* () {
                const session = yield* makeFileSearchSession(
                  { ...input, sessionId: randomUUID() },
                  (notification) =>
                    Effect.sync(() => {
                      safeSendToWebContents(event.sender, "file-search:event", [
                        {
                          ...notification,
                          params: { ...notification.params, sessionId: input.sessionId },
                        },
                      ]);
                    }),
                );
                yield* Effect.acquireRelease(
                  Effect.sync(() => sessions.set(key, session)),
                  () =>
                    Effect.sync(() => {
                      if (sessions.get(key) === session) sessions.delete(key);
                    }),
                );
                yield* Deferred.succeed(ready, undefined);
                return yield* Effect.never;
              }),
            ).pipe(
              Effect.provideService(CodexGateway, gateway),
              Effect.raceFirst(destroyed),
              Effect.catchCause((cause) =>
                Deferred.fail(ready, new FileSearchIpcError({ cause })).pipe(Effect.asVoid),
              ),
            );
            yield* FiberMap.run(lifetimes, key, lifecycle, { startImmediately: true });
            yield* Deferred.await(ready);
          }),
        ),
      ),
    );
    yield* ipc.handleControl("file-search:update", (event, raw) =>
      authorize(event).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const input = yield* parse(() => FileSearchUpdateSchema.parse(raw));
            const session = sessions.get(keyFor(event, input.sessionId));
            if (!session)
              return yield* new FileSearchIpcError({
                cause: new Error("File search session is not owned by this window"),
              });
            yield* session.update(input.query);
          }),
        ),
      ),
    );
    yield* ipc.handleControl("file-search:stop", (event, raw) =>
      authorize(event).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const input = yield* parse(() => FileSearchStopSchema.parse(raw));
            yield* FiberMap.remove(lifetimes, keyFor(event, input.sessionId));
          }),
        ),
      ),
    );
  }),
);
