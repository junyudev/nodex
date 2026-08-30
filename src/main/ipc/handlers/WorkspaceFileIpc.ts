import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FiberMap from "effect/FiberMap";
import * as Hash from "effect/Hash";
import * as Layer from "effect/Layer";
import * as LayerMap from "effect/LayerMap";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import type { IpcEvents } from "../../../shared/ipc-api";
import {
  WorkspaceDirectoryEntriesInputSchema,
  WorkspaceFileMetadataInputSchema,
  WorkspaceFileRequestSchema,
  WorkspaceFileSearchInputSchema,
  WorkspaceFileTextReadInputSchema,
  WorkspaceFileWatchStopInputSchema,
  WorkspaceFileWriteInputSchema,
} from "../../../shared/schemas/workspace-files";
import { MainConfig } from "../../app/MainConfig";
import { type FileWatchError, type FileWatchHost, localFileWatchHost } from "../../file-watch-host";
import { safeSendToWebContents } from "../../ipc-safe-send";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { MAIN_OBSERVATION_EVENT_CAPACITY } from "../../runtime-limits";
import {
  listWorkspaceDirectoryEntries,
  readWorkspaceFile,
  readWorkspaceFileBinary,
  readWorkspaceFileMetadata,
  searchWorkspaceFiles,
  toWorkspaceFileIpcError,
  WorkspaceFileUserError,
  writeWorkspaceFile,
} from "../../workspace-files-service";

export interface WorkspaceFileIpcOptions {
  readonly authorizeSender?: (event: IpcMainInvokeEvent) => boolean;
  readonly fileWatchHost?: FileWatchHost;
  readonly makeSubscriptionId?: () => string;
}

export class WorkspaceFileIpcError extends Schema.TaggedError<WorkspaceFileIpcError>()(
  "WorkspaceFileIpcError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

const sendChanged = (
  owner: IpcMainInvokeEvent["sender"],
  payload: IpcEvents["workspace-file:changed"],
): void => {
  safeSendToWebContents(owner, "workspace-file:changed", [payload]);
};

const watchKey = (ownerId: number, subscriptionId: string): string =>
  `${ownerId}\0${subscriptionId}`;

class WorkspaceWatchKey implements Equal.Equal {
  constructor(
    readonly owner: WebContents,
    readonly path: string,
  ) {}

  [Equal.symbol](that: Equal.Equal): boolean {
    return (
      that instanceof WorkspaceWatchKey && that.owner === this.owner && that.path === this.path
    );
  }

  [Hash.symbol](): number {
    return Hash.combine(Hash.string(this.path))(Hash.hash(this.owner.id));
  }
}

class WorkspaceFileWatch extends Context.Service<
  WorkspaceFileWatch,
  { readonly changes: Stream.Stream<{ readonly changedPaths: readonly string[] }> }
>()("nodex/main/ipc/WorkspaceFileWatch") {}

export const live = (
  options: WorkspaceFileIpcOptions = {},
): Layer.Layer<never, never, ElectronIpc | MainConfig | WindowRuntime> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const config = yield* MainConfig;
      const ipc = yield* ElectronIpc;
      const windows = yield* WindowRuntime;
      const watchHost = options.fileWatchHost ?? localFileWatchHost;
      const makeSubscriptionId = options.makeSubscriptionId ?? randomUUID;
      const subscriptions = yield* FiberMap.make<string>();
      const watches = yield* LayerMap.make(
        (key: WorkspaceWatchKey) =>
          Layer.effect(
            WorkspaceFileWatch,
            Effect.gen(function* () {
              const changes = yield* PubSub.sliding<{
                readonly changedPaths: readonly string[];
              }>(MAIN_OBSERVATION_EVENT_CAPACITY);
              const ready = yield* Deferred.make<void, FileWatchError>();
              yield* watchHost
                .watch({
                  path: dirname(key.path),
                  recursive: false,
                  renameEventHandling: "changed-path-with-parent-directory",
                })
                .pipe(
                  Stream.runForEach((event) =>
                    event._tag === "Ready"
                      ? Deferred.succeed(ready, undefined).pipe(Effect.asVoid)
                      : PubSub.publish(changes, event).pipe(Effect.asVoid),
                  ),
                  Effect.tapError((error) => Deferred.fail(ready, error)),
                  Effect.ensuring(PubSub.shutdown(changes)),
                  Effect.catch(() => Effect.void),
                  Effect.forkScoped({ startImmediately: true }),
                );
              yield* Deferred.await(ready);
              return WorkspaceFileWatch.of({ changes: Stream.fromPubSub(changes) });
            }),
          ),
        { idleTimeToLive: Duration.zero },
      );

      const authorize = (event: IpcMainInvokeEvent) =>
        Effect.try({
          try: () => {
            if (options.authorizeSender) {
              if (!options.authorizeSender(event))
                throw new Error("Unauthorized workspace file access");
              return;
            }
            requireTrustedAppRendererSender(event, "Workspace file access", config.rendererUrl);
            if (!windows.has(event.sender.id)) {
              throw new WorkspaceFileUserError(
                "unauthorized_sender",
                "Workspace file access requires an active Nodex window",
              );
            }
          },
          catch: (cause) =>
            cause instanceof WorkspaceFileUserError
              ? cause
              : new WorkspaceFileUserError(
                  "unauthorized_sender",
                  "Workspace file access is available only to the top-level app renderer",
                  { cause },
                ),
        });
      const mapError = (
        operation: string,
        cause: unknown,
      ): WorkspaceFileUserError | WorkspaceFileIpcError => {
        const mapped = toWorkspaceFileIpcError(cause);
        return mapped instanceof WorkspaceFileUserError
          ? mapped
          : new WorkspaceFileIpcError({ operation, cause: mapped });
      };
      const run = <A>(operation: string, event: IpcMainInvokeEvent, task: () => Promise<A>) =>
        authorize(event).pipe(
          Effect.andThen(
            Effect.tryPromise({
              try: task,
              catch: (cause) => mapError(operation, cause),
            }),
          ),
        );
      const runEffect = <A, E>(
        operation: string,
        event: IpcMainInvokeEvent,
        task: Effect.Effect<A, E>,
      ) =>
        authorize(event).pipe(
          Effect.andThen(task),
          Effect.mapError((cause) => mapError(operation, cause)),
        );

      yield* ipc.handleQuery("workspace-directory-entries", (event, input: unknown) =>
        run("list-directory", event, () =>
          listWorkspaceDirectoryEntries(WorkspaceDirectoryEntriesInputSchema.parse(input)),
        ),
      );
      yield* ipc.handleQuery("workspace-file-search", (event, input: unknown) =>
        run("search-files", event, () =>
          searchWorkspaceFiles(WorkspaceFileSearchInputSchema.parse(input)),
        ),
      );
      yield* ipc.handleQuery("read-file", (event, input: unknown) =>
        run("read-file", event, () =>
          readWorkspaceFile(WorkspaceFileTextReadInputSchema.parse(input)),
        ),
      );
      yield* ipc.handleQuery("read-file-metadata", (event, input: unknown) =>
        run("read-file-metadata", event, () =>
          readWorkspaceFileMetadata(WorkspaceFileMetadataInputSchema.parse(input)),
        ),
      );
      yield* ipc.handleQuery("read-file-binary", (event, input: unknown) =>
        run("read-file-binary", event, () =>
          readWorkspaceFileBinary(WorkspaceFileRequestSchema.parse(input)),
        ),
      );
      yield* ipc.handlePlainCommand("write-file", (event, input: unknown) =>
        run("write-file", event, () =>
          writeWorkspaceFile(WorkspaceFileWriteInputSchema.parse(input)),
        ),
      );
      yield* ipc.handleControl("workspace-file-watch:start", (event, input: unknown) =>
        runEffect(
          "start-file-watch",
          event,
          Effect.gen(function* () {
            const request = yield* Effect.try({
              try: () => WorkspaceFileRequestSchema.parse(input),
              catch: (cause) => mapError("parse-file-watch", cause),
            });
            const owner = event.sender;
            const watchedPath = resolve(request.path);
            if (owner.isDestroyed()) {
              return yield* Effect.fail(
                new WorkspaceFileUserError(
                  "unauthorized_sender",
                  "Workspace file watcher owner is no longer available",
                ),
              );
            }
            const subscriptionId = makeSubscriptionId();
            const ready = yield* Deferred.make<
              void,
              WorkspaceFileUserError | WorkspaceFileIpcError
            >();
            const ownerDestroyed = Effect.callback<void>((resume) => {
              const onDestroyed = () => resume(Effect.void);
              owner.once("destroyed", onDestroyed);
              if (owner.isDestroyed()) resume(Effect.void);
              return Effect.sync(() => owner.removeListener("destroyed", onDestroyed));
            });
            const lifecycle = Effect.raceFirst(
              Effect.scoped(
                Effect.gen(function* () {
                  const context = yield* watches.contextEffect(
                    new WorkspaceWatchKey(owner, watchedPath),
                  );
                  const watch = Context.get(context, WorkspaceFileWatch);
                  yield* Deferred.succeed(ready, undefined);
                  yield* watch.changes.pipe(
                    Stream.runForEach((watchEvent) => {
                      const exactPathChanged =
                        watchEvent.changedPaths.length === 0 ||
                        watchEvent.changedPaths.some(
                          (changedPath) => resolve(changedPath) === watchedPath,
                        );
                      if (!exactPathChanged || owner.isDestroyed()) return Effect.void;
                      return Effect.sync(() =>
                        sendChanged(owner, { subscriptionId, path: watchedPath }),
                      );
                    }),
                  );
                }),
              ),
              ownerDestroyed.pipe(
                Effect.andThen(
                  Effect.fail(
                    new WorkspaceFileUserError(
                      "unauthorized_sender",
                      "Workspace file watcher owner is no longer available",
                    ),
                  ),
                ),
              ),
            ).pipe(
              Effect.catch((cause) =>
                Deferred.fail(ready, mapError("acquire-file-watch", cause)).pipe(Effect.asVoid),
              ),
            );
            yield* FiberMap.run(subscriptions, watchKey(owner.id, subscriptionId), lifecycle, {
              startImmediately: true,
            });
            yield* Deferred.await(ready);
            return { subscriptionId };
          }),
        ),
      );
      yield* ipc.handleControl("workspace-file-watch:stop", (event, input: unknown) =>
        runEffect(
          "stop-file-watch",
          event,
          Effect.gen(function* () {
            const request = yield* Effect.try({
              try: () => WorkspaceFileWatchStopInputSchema.parse(input),
              catch: (cause) => mapError("parse-file-watch-stop", cause),
            });
            yield* FiberMap.remove(
              subscriptions,
              watchKey(event.sender.id, request.subscriptionId),
            );
          }),
        ),
      );
    }),
  );
