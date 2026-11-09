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
import { ElectronIpc, ElectronSpaceIpc, live, mapElectronIpcHandlers } from "./ElectronIpc";

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
  return handler(event, { spaceId: "personal", args: [request] });
};

const makeIpc = Effect.fn("makeIpc")(function* () {
  const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const context = yield* Layer.buildWithScope(live.pipe(Layer.provide(callbacks)), scope);
  yield* Context.get(context, ElectronSpaceIpc)
    .configure(({ request, personal }) => {
      const envelope = request as { spaceId: string; args: readonly unknown[] };
      if (!envelope || envelope.spaceId !== "personal" || !Array.isArray(envelope.args))
        return Effect.fail(new Error("Unknown Space"));
      return personal(envelope.args);
    })
    .pipe(Effect.provideService(Scope.Scope, scope));
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

it.effect("fences content and Member settings ingress before a personal handler can run", () =>
  Effect.gen(function* () {
    const { ipc, scope } = yield* makeIpc();
    yield* Effect.gen(function* () {
      yield* ipc.handleQuery("settings:inbox:get", () =>
        Effect.die("Must not read personal consent"),
      );
      yield* ipc.handlePlainCommand("settings:inbox:update", () =>
        Effect.die("Must not write personal consent"),
      );
      yield* ipc.handleQuery("automations:list", () => Effect.succeed({ items: [] }));
      yield* ipc.handleQuery("sources:automation-options", () =>
        Effect.succeed([{ id: "source", label: "Alice" }]),
      );
      yield* ipc.handlePlainCommand("automations:update", () =>
        Effect.die("Must not run in personal Space"),
      );
      yield* ipc.handleQuery("inbox:prepare-confirmation", () =>
        Effect.die("Must not prepare personal execution"),
      );
      yield* ipc.handleLocalCommitCommand("inbox:confirm", () =>
        Effect.die("Must not execute personal work"),
      );
      for (const key of [
        "settings:inbox:get",
        "settings:inbox:update",
        "automations:list",
        "sources:automation-options",
        "automations:update",
        "inbox:prepare-confirmation",
        "inbox:confirm",
      ]) {
        const handler = handlers.get(key)!;
        for (const raw of [
          { args: [] },
          { spaceId: "unknown", args: [] },
          {
            spaceId: "team",
            args: [{ action: { type: "execute_decision", decisionId: "same-decision" } }],
          },
        ]) {
          yield* Effect.promise(() => expect(handler(event, raw)).rejects.toThrow("Unknown Space"));
        }
      }
      expect(
        yield* Effect.promise(() =>
          handlers.get("automations:list")!(event, { spaceId: "personal", args: [] }),
        ),
      ).toEqual({ items: [] });
      expect(
        yield* Effect.promise(() =>
          handlers.get("sources:automation-options")!(event, { spaceId: "personal", args: [] }),
        ),
      ).toEqual([{ id: "source", label: "Alice" }]);
    }).pipe(Effect.provideService(Scope.Scope, scope));
    yield* Scope.close(scope, Exit.void);
  }),
);
it.effect("a window's device channels run on this desktop whichever Space it shows", () =>
  Effect.gen(function* () {
    const { ipc, scope } = yield* makeIpc();
    yield* Effect.gen(function* () {
      yield* ipc.handleQuery("electron-window:focus:get", () => Effect.succeed(true));
      yield* ipc.handleQuery("codex-command-keymap-state", () => Effect.succeed("keymap" as never));
      yield* ipc.handleControl("global-dictation:keyboard-layout:update", () =>
        Effect.succeed(undefined as never),
      );
      yield* ipc.handlePlainCommand("product-analytics:record", () =>
        Effect.succeed(undefined as never),
      );
      yield* ipc.handleQuery("codex:dictation:state:read", () => Effect.succeed("ready" as never));
      yield* ipc.handleQuery("codex:sidebar:snapshot", () =>
        Effect.die("A team window must not reach the desktop's native chats"),
      );
      // A team window sends these without a Space; the Space router, which rejects every Space
      // but the personal one here, never sees them.
      expect(yield* Effect.promise(() => handlers.get("electron-window:focus:get")!(event))).toBe(
        true,
      );
      expect(yield* Effect.promise(() => handlers.get("codex-command-keymap-state")!(event))).toBe(
        "keymap",
      );
      expect(yield* Effect.promise(() => handlers.get("codex:dictation:state:read")!(event))).toBe(
        "ready",
      );
      yield* Effect.promise(() =>
        handlers.get("global-dictation:keyboard-layout:update")!(event, { layout: "us" }),
      );
      yield* Effect.promise(() => handlers.get("product-analytics:record")!(event, {}));
      // The desktop's own chats stay behind the Space router.
      yield* Effect.promise(() =>
        expect(
          handlers.get("codex:sidebar:snapshot")!(event, { spaceId: "team", args: [] }),
        ).rejects.toThrow("Unknown Space"),
      );
    }).pipe(Effect.provideService(Scope.Scope, scope));
    yield* Scope.close(scope, Exit.void);
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
