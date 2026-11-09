import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import type { IpcMainInvokeEvent } from "electron";
import type { IpcApi } from "../../shared/ipc-api";
import {
  ElectronIpc,
  type ElectronIpcHandler,
  type ElectronIpcResultDelivery,
  type ElectronIpcWireResult,
} from "../platform/electron/ElectronIpc";

type Handler = (
  event: IpcMainInvokeEvent,
  args: readonly unknown[],
) => Effect.Effect<unknown, unknown>;

  const handlers = new Map<keyof IpcApi, Handler>();
  const register = <
    Channel extends keyof IpcApi,
    Result extends ElectronIpcWireResult<IpcApi[Channel]["result"]>,
  >(
    channel: Channel,
    handler: ElectronIpcHandler<Channel, Result>,
    delivery?: ElectronIpcResultDelivery<Channel, Result>,
  ): Effect.Effect<void, never, Scope.Scope> =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const bound: Handler = (event, args) => {
          const task = Reflect.apply(handler, undefined, [event, ...args]) as Effect.Effect<
            Result,
            unknown
          >;
          return task.pipe(
            Effect.flatMap((result) =>
              delivery
                ? delivery.deliver(event, args as IpcApi[Channel]["args"], result)
                : Effect.succeed(result),
            ),
          );
        };
        if (handlers.has(channel)) throw new Error(`Duplicate Space IPC handler: ${channel}`);
        handlers.set(channel, bound);
      }),
      () =>
        Effect.sync(() => {
          handlers.delete(channel);
        }),
    );
  return {
    ipc: ElectronIpc.of({
      handleQuery: register,
      handleControl: register,
      handleLocalCommitCommand: register,
      handleRevisionedCommand: register,
      handlePlainCommand: register,
      on: () => Effect.die(new Error("Remote Spaces cannot acquire native event ingress")),
    }),
    invoke: (channel: keyof IpcApi, event: IpcMainInvokeEvent, args: readonly unknown[]) =>
      Effect.suspend(() => {
        const handler = handlers.get(channel);
        if (!handler) return Effect.fail(new Error("This feature runs on the Space host"));
        return handler(event, args);
      }),
  };
}
