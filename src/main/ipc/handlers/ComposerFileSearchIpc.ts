import { isAbsolute } from "node:path";
import type { IpcMainInvokeEvent } from "electron";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  ComposerFileSearchStartSchema,
  ComposerFileSearchStopSchema,
  ComposerFileSearchUpdateSchema,
} from "../../../shared/schemas/composer-file-search";
import { MainConfig } from "../../app/MainConfig";
import {
  makeComposerFileSearchSession,
  type ComposerFileSearchSession,
} from "../../codex-application/ComposerFileSearch";
import { CodexGateway } from "../../codex-runtime/CodexGateway";
import { safeSendToWebContents } from "../../ipc-safe-send";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

export class ComposerFileSearchIpcError extends Schema.TaggedError<ComposerFileSearchIpcError>()(
  "ComposerFileSearchIpcError",
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
    const sessions = new Map<string, ComposerFileSearchSession>();
    const keyFor = (event: IpcMainInvokeEvent, sessionId: string) =>
      `${event.sender.id}\0${sessionId}`;
    const authorize = (event: IpcMainInvokeEvent) =>
      Effect.try({
        try: () => {
          requireTrustedAppRendererSender(event, "Composer file search", config.rendererUrl);
          if (!windows.has(event.sender.id) || event.sender.isDestroyed())
            throw new Error("Composer file search requires an active Nodex window");
        },
        catch: (cause) => new ComposerFileSearchIpcError({ cause }),
      });
    const parse = <A>(read: () => A) =>
      Effect.try({ try: read, catch: (cause) => new ComposerFileSearchIpcError({ cause }) });

    yield* ipc.handleControl("codex:composer-file-search:start", (event, raw) =>
      authorize(event).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const input = yield* parse(() => ComposerFileSearchStartSchema.parse(raw));
            if (input.roots.some((root) => !isAbsolute(root)))
              return yield* new ComposerFileSearchIpcError({
                cause: new Error("Search roots must be absolute paths"),
              });
            const key = keyFor(event, input.sessionId);
            const ready = yield* Deferred.make<void, ComposerFileSearchIpcError>();
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
                const session = yield* makeComposerFileSearchSession(input, (notification) =>
                  Effect.sync(() => {
                    safeSendToWebContents(event.sender, "codex:composer-file-search:event", [
                      notification,
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
                Deferred.fail(ready, new ComposerFileSearchIpcError({ cause })).pipe(Effect.asVoid),
              ),
            );
            yield* FiberMap.run(lifetimes, key, lifecycle, { startImmediately: true });
            yield* Deferred.await(ready);
          }),
        ),
      ),
    );
    yield* ipc.handleControl("codex:composer-file-search:update", (event, raw) =>
      authorize(event).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const input = yield* parse(() => ComposerFileSearchUpdateSchema.parse(raw));
            const session = sessions.get(keyFor(event, input.sessionId));
            if (!session)
              return yield* new ComposerFileSearchIpcError({
                cause: new Error("Composer file search session is not owned by this window"),
              });
            yield* session.update(input.query);
          }),
        ),
      ),
    );
    yield* ipc.handleControl("codex:composer-file-search:stop", (event, raw) =>
      authorize(event).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const input = yield* parse(() => ComposerFileSearchStopSchema.parse(raw));
            yield* FiberMap.remove(lifetimes, keyFor(event, input.sessionId));
          }),
        ),
      ),
    );
  }),
);
