import { EventEmitter } from "node:events";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { IpcMainInvokeEvent } from "electron";
import { AgentBackendApplication } from "../../agent-backend/AgentBackendApplication";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { AgentBackendIpcError, live } from "./AgentBackendIpc";

type Handler = (
  event: IpcMainInvokeEvent,
  value: unknown,
) => Effect.Effect<unknown, AgentBackendIpcError>;

it.effect("bridges renderer observation reference counts and destruction into session leases", () =>
  Effect.gen(function* () {
    const handlers = new Map<string, Handler>();
    const ipc = makeTestElectronIpc({
      handle: (channel: string, handler: Handler) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            handlers.set(channel, handler);
          }),
          () =>
            Effect.sync(() => {
              handlers.delete(channel);
            }),
        ).pipe(Effect.asVoid),
      on: () => Effect.void,
    });
    const observed: string[] = [];
    const unobserved: string[] = [];
    const destructionReleased = yield* Deferred.make<void>();
    const application = AgentBackendApplication.of({
      observeAcpSession: (threadId: string) =>
        Effect.sync(() => {
          observed.push(threadId);
        }),
      unobserveAcpSession: (threadId: string) =>
        Effect.sync(() => {
          unobserved.push(threadId);
        }).pipe(
          Effect.flatMap(() =>
            unobserved.length >= 2
              ? Deferred.succeed(destructionReleased, undefined).pipe(Effect.asVoid)
              : Effect.void,
          ),
        ),
      changes: Stream.empty,
    } as unknown as AgentBackendApplication["Service"]);
    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(
      live.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(AgentBackendApplication, application),
            Layer.succeed(ElectronIpc, ipc),
            mainConfigLayer(),
            Layer.succeed(
              WindowRuntime,
              WindowRuntime.of({ has: () => true } as unknown as WindowRuntime["Service"]),
            ),
          ),
        ),
      ),
      scope,
    );

    const sender = Object.assign(new EventEmitter(), {
      id: 77,
      getType: () => "window",
      isDestroyed: () => false,
    });
    const frame = { url: "app://-/index.html" };
    Object.assign(sender, { mainFrame: frame });
    const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent;
    const observe = handlers.get("agent-backend:acp:session:observe");
    const unobserve = handlers.get("agent-backend:acp:session:unobserve");
    expect(observe).toBeDefined();
    expect(unobserve).toBeDefined();

    yield* observe!(event, "thread-a");
    yield* observe!(event, "thread-a");
    expect(observed).toEqual(["thread-a"]);

    yield* unobserve!(event, "thread-a");
    expect(unobserved).toEqual([]);
    yield* unobserve!(event, "thread-a");
    expect(unobserved).toEqual(["thread-a"]);

    observed.length = 0;
    unobserved.length = 0;
    yield* observe!(event, "thread-a");
    yield* observe!(event, "thread-b");
    sender.emit("destroyed");
    yield* Deferred.await(destructionReleased);
    expect(observed).toEqual(["thread-a", "thread-b"]);
    expect(new Set(unobserved)).toEqual(new Set(["thread-a", "thread-b"]));

    const closingSender = Object.assign(new EventEmitter(), {
      id: 78,
      getType: () => "window",
      isDestroyed: () => false,
      mainFrame: frame,
    });
    const closingEvent = {
      sender: closingSender,
      senderFrame: frame,
    } as unknown as IpcMainInvokeEvent;
    yield* observe!(closingEvent, "thread-c");
    yield* Scope.close(scope, Exit.void);
    expect(unobserved).toContain("thread-c");
    expect(closingSender.listenerCount("destroyed")).toBe(0);
    expect(handlers.size).toBe(0);
  }),
);
