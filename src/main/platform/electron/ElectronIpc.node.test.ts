import { EventEmitter } from "node:events";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { it } from "@effect/vitest";
import { expect, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import type { IpcMainInvokeEvent } from "electron";
import { layer as callbacks } from "../../app/ScopedCallbackRuntime";
import { ElectronIpc, live, mapElectronIpcHandlers } from "./ElectronIpc";

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>,
    ) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
}));

const channel = "codex:app-server:request";
const request = {
  hostId: "local",
  caller: { requestId: "one", timeoutMs: 0, expiresAtMs: null },
  request: { method: "model/list", id: "one", params: {} },
} as const;
const event = { sender: { id: 8 } } as IpcMainInvokeEvent;
const invoke = () => {
  const handler = handlers.get(channel);
  if (!handler) throw new Error("Missing registered native request handler");
  return handler(event, request);
};

const makeIpc = Effect.fn("makeIpc")(function* () {
  const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const context = yield* Layer.buildWithScope(live.pipe(Layer.provide(callbacks)), scope);
  return { ipc: Context.get(context, ElectronIpc), scope };
});

it.effect(
  "separate result delivery follows mapped execution and replaces the physical invoke result",
  () =>
    Effect.gen(function* () {
      const order: string[] = [];
      const { ipc, scope } = yield* makeIpc();
      yield* Effect.gen(function* () {
        const mapped = mapElectronIpcHandlers(ipc, (_channel, handler) => {
          order.push("map");
          return handler;
        });
        const result = { type: "result", result: { data: ["payload"] } } as const;
        yield* mapped.handleControl(
          channel,
          () =>
            Effect.sync(() => {
              order.push("execute");
              return result;
            }),
          {
            deliver: (receivedEvent, args, outcome) =>
              Effect.sync(() => {
                order.push("deliver");
                expect(receivedEvent).toBe(event);
                expect(args).toEqual([request]);
                expect(outcome).toBe(result);
              }),
          },
        );
        const acknowledged = yield* Effect.promise(invoke);
        expect(acknowledged).toBeUndefined();
        expect(order).toEqual(["map", "execute", "deliver"]);
      }).pipe(Effect.provideService(Scope.Scope, scope));
      yield* Scope.close(scope, Exit.void);
      expect(handlers.has(channel)).toBe(false);
    }),
);

it.effect(
  "ordinary invoke retains its result and delivery failures reject the physical dispatch",
  () =>
    Effect.gen(function* () {
      const result = { type: "result", result: false } as const;
      const { ipc, scope } = yield* makeIpc();
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ipc.handleControl(channel, () => Effect.succeed(result));
          expect(yield* Effect.promise(invoke)).toEqual(result);
        }),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ipc.handleControl(channel, () => Effect.succeed(result), {
            deliver: () => Effect.die(new Error("delivery unavailable")),
          });
          yield* Effect.promise(() => expect(invoke()).rejects.toThrow("delivery unavailable"));
        }),
      );
      yield* Scope.close(scope, Exit.void);
      expect(handlers.has(channel)).toBe(false);
    }),
);

for (const end of ["sender", "registration", "failure"] as const) {
  it.effect(`a held catalog read drains when ${end} ends its lifetime`, () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const failed = yield* Deferred.make<void>();
      const releaseCleanup = yield* Deferred.make<void>();
      const cleanupStarted = yield* Deferred.make<void>();
      const cleanupFinished = yield* Deferred.make<void>();
      const sender = new EventEmitter() as EventEmitter & { isDestroyed: () => boolean };
      let gone = false;
      sender.isDestroyed = () => gone;
      const { ipc, scope } = yield* makeIpc();
      yield* ipc
        .handleQuery("agent-runtime:providers:read", () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(failed)),
            Effect.andThen(Effect.fail(new Error("Runtime process exited"))),
            Effect.ensuring(
              Deferred.succeed(cleanupStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseCleanup)),
                Effect.andThen(Deferred.succeed(cleanupFinished, undefined)),
              ),
            ),
          ),
        )
        .pipe(Effect.provideService(Scope.Scope, scope));
      const physical = handlers.get("agent-runtime:providers:read")!;
      let settled = false;
      const result = physical({ sender } as unknown as IpcMainInvokeEvent).then(
        (value) => {
          settled = true;
          return { value };
        },
        (error) => {
          settled = true;
          return { error };
        },
      );
      yield* Deferred.await(started);
      const registrationClose =
        end === "registration"
          ? Scope.close(scope, Exit.void).pipe(Effect.forkChild)
          : Effect.succeed(undefined);
      if (end === "sender") {
        gone = true;
        sender.emit("destroyed");
      } else if (end === "failure") yield* Deferred.succeed(failed, undefined);
      const closing = yield* registrationClose;
      yield* Deferred.await(cleanupStarted);
      expect(settled).toBe(false);
      yield* Deferred.succeed(releaseCleanup, undefined);
      const outcome = yield* Effect.promise(() => result);
      yield* Deferred.await(cleanupFinished);
      if (end !== "failure") expect(outcome).toEqual({ value: undefined });
      else expect(outcome).toMatchObject({ error: new Error("Runtime process exited") });
      expect(sender.listenerCount("destroyed")).toBe(0);
      if (closing) yield* Fiber.join(closing);
      yield* Scope.close(scope, Exit.void);
    }),
  );
}
