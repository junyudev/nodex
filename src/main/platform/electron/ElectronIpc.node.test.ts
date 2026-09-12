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
