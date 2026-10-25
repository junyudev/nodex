import { EventEmitter } from "node:events";
import { assert, it } from "@effect/vitest";
import type { IpcMainInvokeEvent } from "electron";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { vi } from "vitest";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { WorkspaceTextSearch } from "../../codex-application/WorkspaceTextSearch";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live } from "./WorkspaceTextSearchIpc";

vi.mock("../../platform/electron/TrustedRendererSender", () => ({
  requireTrustedAppRendererSender: () => undefined,
}));
type Handler = (event: IpcMainInvokeEvent, ...args: readonly unknown[]) => Effect.Effect<unknown>;

it.effect(
  "owns cancellation by window and request, replacing requests and releasing destroyed windows and Main",
  () =>
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
          ),
        on: () => Effect.die("unused"),
      });
      const active = new Set<number>();
      let next = 0;
      const started = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      const service = WorkspaceTextSearch.of({
        search: () =>
          Effect.acquireUseRelease(
            Effect.sync(() => {
              const id = ++next;
              active.add(id);
              return id;
            }),
            () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
            (id) =>
              Effect.sync(() => {
                active.delete(id);
              }).pipe(Effect.andThen(Deferred.succeed(stopped, undefined))),
          ),
      });
      const sender = (id: number) =>
        Object.assign(new EventEmitter(), { id, isDestroyed: () => false, send: () => undefined });
      const a = sender(1);
      const b = sender(2);
      const eventA = { sender: a } as unknown as IpcMainInvokeEvent;
      const eventB = { sender: b } as unknown as IpcMainInvokeEvent;
      const scope = yield* Scope.make();
      yield* Layer.buildWithScope(
        live.pipe(
          Layer.provide(
            Layer.mergeAll(
              mainConfigLayer(),
              Layer.succeed(ElectronIpc, ipc),
              Layer.succeed(WorkspaceTextSearch, service),
              Layer.succeed(WindowRuntime, {
                has: () => true,
              } as unknown as WindowRuntime["Service"]),
            ),
          ),
        ),
        scope,
      );
      const request = {
        requestId: "f3ebc134-7b2b-4c8d-8758-01e7b2a87065",
        hostId: "local",
        roots: ["/workspace"],
        query: "needle",
      };
      const start = handlers.get("workspace-text-search:start")!;
      const stop = handlers.get("workspace-text-search:stop")!;
      yield* start(eventA, request);
      yield* Deferred.await(started);
      assert.deepEqual([...active], [1]);
      yield* stop(eventB, { requestId: request.requestId });
      assert.deepEqual([...active], [1]);
      yield* start(eventA, request);
      yield* Effect.yieldNow;
      assert.deepEqual([...active], [2]);
      yield* start(eventB, request);
      yield* Effect.yieldNow;
      assert.deepEqual([...active], [2, 3]);
      a.emit("destroyed");
      yield* Effect.yieldNow;
      assert.deepEqual([...active], [3]);
      assert.equal(a.listenerCount("destroyed"), 0);
      yield* Scope.close(scope, Exit.void);
      assert.equal(active.size, 0);
      assert.equal(b.listenerCount("destroyed"), 0);
      assert.equal(handlers.size, 0);
    }),
);
