import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import { WebContentsDestructionSubscriptions } from "./WebContentsDestructionSubscriptions";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import type {
  CoreLocalCommitCommandChannel,
  IpcControlChannel,
  IpcQueryChannel,
  MainRevisionCommandChannel,
  PlainResultCommandChannel,
} from "../../../shared/ipc-endpoint-policy";
import type { IpcApi } from "../../../shared/ipc-api";
import { isSpaceIpcChannel } from "../../../shared/space-ipc-policy";
import { ScopedCallbackRuntime } from "../../app/ScopedCallbackRuntime";
import { toElectronIpcRendererError } from "./electron-ipc-error";

type ElectronIpcReadonlyWireResult<Value> = Value extends (...args: never[]) => unknown
  ? Value
  : Value extends readonly (infer Item)[]
    ? readonly ElectronIpcReadonlyWireResult<Item>[]
    : Value extends object
      ? { readonly [Key in keyof Value]: ElectronIpcReadonlyWireResult<Value[Key]> }
      : Value;

export type ElectronIpcWireResult<Value> = Value | ElectronIpcReadonlyWireResult<Value>;

/** A semantic result may use a separate, flow-controlled response channel. Invoke then carries only completion. */
export interface ElectronIpcResultDelivery<Channel extends keyof IpcApi, Result> {
  readonly deliver: (
    event: IpcMainInvokeEvent,
    args: IpcApi[Channel]["args"],
    result: Result,
  ) => Effect.Effect<void>;
}

export type ElectronIpcHandler<
  Channel extends keyof IpcApi,
  Result extends ElectronIpcWireResult<IpcApi[Channel]["result"]> = ElectronIpcWireResult<
    IpcApi[Channel]["result"]
  >,
> = (event: IpcMainInvokeEvent, ...args: IpcApi[Channel]["args"]) => Effect.Effect<Result, unknown>;

export type ElectronIpcQueryHandler<
  Channel extends IpcQueryChannel,
  Result extends ElectronIpcWireResult<IpcApi[Channel]["result"]> = ElectronIpcWireResult<
    IpcApi[Channel]["result"]
  >,
> = ElectronIpcHandler<Channel, Result>;
export type ElectronIpcControlHandler<
  Channel extends IpcControlChannel,
  Result extends ElectronIpcWireResult<IpcApi[Channel]["result"]> = ElectronIpcWireResult<
    IpcApi[Channel]["result"]
  >,
> = ElectronIpcHandler<Channel, Result>;
export type ElectronIpcLocalCommitCommandHandler<
  Channel extends CoreLocalCommitCommandChannel,
  Result extends ElectronIpcWireResult<IpcApi[Channel]["result"]> = ElectronIpcWireResult<
    IpcApi[Channel]["result"]
  >,
> = ElectronIpcHandler<Channel, Result>;
export type ElectronIpcRevisionedCommandHandler<
  Channel extends MainRevisionCommandChannel,
  Result extends ElectronIpcWireResult<IpcApi[Channel]["result"]> = ElectronIpcWireResult<
    IpcApi[Channel]["result"]
  >,
> = ElectronIpcHandler<Channel, Result>;
export type ElectronIpcPlainCommandHandler<
  Channel extends PlainResultCommandChannel,
  Result extends ElectronIpcWireResult<IpcApi[Channel]["result"]> = ElectronIpcWireResult<
    IpcApi[Channel]["result"]
  >,
> = ElectronIpcHandler<Channel, Result>;

export class ElectronIpc extends Context.Service<
  ElectronIpc,
  {
    readonly handleQuery: <
      Channel extends IpcQueryChannel,
      Result extends ElectronIpcWireResult<IpcApi[Channel]["result"]>,
    >(
      channel: Channel,
      handler: ElectronIpcHandler<Channel, Result>,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly handleControl: <
      Channel extends IpcControlChannel,
      Result extends ElectronIpcWireResult<IpcApi[Channel]["result"]>,
    >(
      channel: Channel,
      handler: ElectronIpcHandler<Channel, Result>,
      delivery?: ElectronIpcResultDelivery<Channel, Result>,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly handleLocalCommitCommand: <
      Channel extends CoreLocalCommitCommandChannel,
      Result extends ElectronIpcWireResult<IpcApi[Channel]["result"]>,
    >(
      channel: Channel,
      handler: ElectronIpcHandler<Channel, Result>,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly handleRevisionedCommand: <
      Channel extends MainRevisionCommandChannel,
      Result extends ElectronIpcWireResult<IpcApi[Channel]["result"]>,
    >(
      channel: Channel,
      handler: ElectronIpcHandler<Channel, Result>,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly handlePlainCommand: <
      Channel extends PlainResultCommandChannel,
      Result extends ElectronIpcWireResult<IpcApi[Channel]["result"]>,
    >(
      channel: Channel,
      handler: ElectronIpcHandler<Channel, Result>,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly on: <Args extends readonly unknown[]>(
      channel: string,
      handler: (event: IpcMainEvent, ...args: Args) => Effect.Effect<void>,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("nodex/main/platform/electron/ElectronIpc") {}

type ElectronIpcHandlerMapper = <
  Channel extends keyof IpcApi,
  Result extends ElectronIpcWireResult<IpcApi[Channel]["result"]>,
>(
  channel: Channel,
  handler: ElectronIpcHandler<Channel, Result>,
) => ElectronIpcHandler<Channel, Result>;

/** Decorates every typed registration lane without reopening an unclassified channel seam. */
export const mapElectronIpcHandlers = (
  ipc: Context.Service.Shape<typeof ElectronIpc>,
  mapHandler: ElectronIpcHandlerMapper,
): Pick<
  Context.Service.Shape<typeof ElectronIpc>,
  | "handleControl"
  | "handleLocalCommitCommand"
  | "handlePlainCommand"
  | "handleQuery"
  | "handleRevisionedCommand"
> => ({
  handleQuery: (channel, handler) => ipc.handleQuery(channel, mapHandler(channel, handler)),
  handleControl: (channel, handler, delivery) =>
    ipc.handleControl(channel, mapHandler(channel, handler), delivery),
  handleLocalCommitCommand: (channel, handler) =>
    ipc.handleLocalCommitCommand(channel, mapHandler(channel, handler)),
  handleRevisionedCommand: (channel, handler) =>
    ipc.handleRevisionedCommand(channel, mapHandler(channel, handler)),
  handlePlainCommand: (channel, handler) =>
    ipc.handlePlainCommand(channel, mapHandler(channel, handler)),
});

/** Synchronous preload contracts cannot cross an Effect fiber boundary. Keep this seam pure and scoped. */
export class ElectronSyncIpc extends Context.Service<
  ElectronSyncIpc,
  {
    readonly on: <Args extends readonly unknown[]>(
      channel: string,
      handler: (event: IpcMainEvent, ...args: Args) => void,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("nodex/main/platform/electron/ElectronSyncIpc") {}

export type SpaceIpcDispatch = (input: {
  readonly channel: keyof IpcApi;
  readonly event: IpcMainInvokeEvent;
  readonly request: unknown;
  readonly personal: (args: readonly unknown[]) => Effect.Effect<unknown, unknown>;
}) => Effect.Effect<unknown, unknown>;

/** Installed after personal Core acquisition; bootstrap IPC never depends on Core. */
export class ElectronSpaceIpc extends Context.Service<
  ElectronSpaceIpc,
  {
    readonly configure: (dispatch: SpaceIpcDispatch) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("nodex/main/platform/electron/ElectronSpaceIpc") {}

const asyncLive: Layer.Layer<
  ElectronIpc,
  never,
  ScopedCallbackRuntime | WebContentsDestructionSubscriptions
> = Layer.effect(
  ElectronIpc,
  Effect.gen(function* () {
    const callbacks = yield* ScopedCallbackRuntime;
    const destruction = yield* WebContentsDestructionSubscriptions;
    const handle = <
      Channel extends keyof IpcApi,
      Result extends ElectronIpcWireResult<IpcApi[Channel]["result"]>,
    >(
      channel: Channel,
      handler: ElectronIpcHandler<Channel, Result>,
      delivery?: ElectronIpcResultDelivery<Channel, Result>,
      query = false,
    ): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function* () {
        const queryScope = query ? yield* Scope.fork(yield* Scope.Scope) : undefined;
        let closing = false;
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            ipcMain.handle(channel, (event, ...args) => {
              const personal = (arguments_: readonly unknown[]) => {
                const task = Reflect.apply(handler, undefined, [
                  event,
                  ...arguments_,
                ]) as Effect.Effect<unknown, unknown>;
                return task.pipe(
                  Effect.flatMap((result) =>
                    delivery
                      ? delivery.deliver(
                          event,
                          arguments_ as IpcApi[Channel]["args"],
                          result as Result,
                        )
                      : Effect.succeed(result),
                  ),
                );
              };
              const task = isSpaceIpcChannel(channel)
                ? Effect.suspend(() =>
                    spaceDispatch
                      ? spaceDispatch({
                          channel,
                          event,
                          request: args.length === 1 ? args[0] : undefined,
                          personal,
                        })
                      : Effect.fail(new Error("Space routing is not ready")),
                  )
                : personal(args);
              return callbacks.runPromise(
                Effect.gen(function* () {
                  if (!queryScope) return yield* task;
                  const fiber = yield* Effect.raceFirst(task, destruction.wait(event.sender)).pipe(
                    Effect.forkIn(queryScope),
                  );
                  const exit = yield* Fiber.await(fiber);
                  if (event.sender.isDestroyed() || closing) return undefined;
                  if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause);
                  return exit.value;
                }).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logError("Electron IPC handler failed").pipe(
                      Effect.annotateLogs({ channel, cause: Cause.pretty(cause) }),
                      Effect.andThen(Effect.fail(toElectronIpcRendererError(Cause.squash(cause)))),
                    ),
                  ),
                ),
              );
            });
          }),
          () =>
            Effect.sync(() => {
              closing = true;
              ipcMain.removeHandler(channel);
            }).pipe(Effect.andThen(queryScope ? Scope.close(queryScope, Exit.void) : Effect.void)),
        );
      });
    return ElectronIpc.of({
      handleQuery: (channel, handler) => handle(channel, handler, undefined, true),
      handleControl: handle,
      handleLocalCommitCommand: handle,
      handleRevisionedCommand: handle,
      handlePlainCommand: handle,
      on: (channel, handler) => {
        const listener = (event: IpcMainEvent, ...args: unknown[]) => {
          const task = Reflect.apply(handler, undefined, [event, ...args]) as Effect.Effect<void>;
          callbacks.fork(task);
        };
        return Effect.acquireRelease(
          Effect.sync(() => ipcMain.on(channel, listener)),
          () => Effect.sync(() => ipcMain.removeListener(channel, listener)),
        );
      },
    });
                Effect.sync(() => {
                }),
  }),
);

const syncLive: Layer.Layer<ElectronSyncIpc> = Layer.succeed(
  ElectronSyncIpc,
  ElectronSyncIpc.of({
    on: (channel, handler) => {
      const listener = (event: IpcMainEvent, ...args: unknown[]) => {
        Reflect.apply(handler, undefined, [event, ...args]);
      };
      return Effect.acquireRelease(
        Effect.sync(() => ipcMain.on(channel, listener)),
        () => Effect.sync(() => ipcMain.removeListener(channel, listener)),
      );
    },
  }),
);

export const live: Layer.Layer<
  ElectronIpc | ElectronSpaceIpc | ElectronSyncIpc,
  never,
  ScopedCallbackRuntime
