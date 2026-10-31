import { EventEmitter } from "node:events";
import type { IpcMainInvokeEvent } from "electron";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import { vi } from "vite-plus/test";
import type { PageTextRewriteEvent, PageTextRewriteInput } from "../../../shared/page-text-rewrite";
import { testLayer } from "../../app/MainConfig";
import {
  PageTextRewrite,
  type PageTextRewriteError,
} from "../../page-text-rewrite/PageTextRewrite";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { WebContentsDestructionSubscriptions } from "../../platform/electron/WebContentsDestructionSubscriptions";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live } from "./PageTextRewriteIpc";

vi.mock("../../platform/electron/TrustedRendererSender", () => ({
  requireTrustedAppRendererSender: (event: IpcMainInvokeEvent) => {
    if (event.sender.id === 9) throw new Error("Untrusted");
  },
}));

type Handler = (
  event: IpcMainInvokeEvent,
  input: unknown,
) => Effect.Effect<unknown, PageTextRewriteError>;
const requestId = "d603c1ba-b905-4617-8de9-c5c6f5847704";
const input = { markdown: "Selected", instruction: "Make concise" };

it.effect(
  "validates at ingress, isolates window ownership and releases work on cancel, destruction and shutdown",
  () =>
    Effect.gen(function* () {
      const handlers = new Map<string, Handler>();
      const emitted = yield* Queue.unbounded<PageTextRewriteEvent>();
      let started = yield* Deferred.make<void>();
      let reply = yield* Deferred.make<string>();
      let stopped = yield* Deferred.make<void>();
      const calls: PageTextRewriteInput[] = [];
      const scope = yield* Scope.make();
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
      yield* Layer.buildWithScope(
        live.pipe(
          Layer.provide(WebContentsDestructionSubscriptions.live),
          Layer.provide(
            Layer.mergeAll(
              testLayer(),
              Layer.succeed(ElectronIpc, ipc),
              Layer.succeed(WindowRuntime, {
                has: (id: number) => id === 1 || id === 2 || id === 9,
              } as unknown as WindowRuntime["Service"]),
              Layer.succeed(PageTextRewrite, {
                generate: (selection) => {
                  calls.push(selection);
                  return Deferred.succeed(started, undefined).pipe(
                    Effect.andThen(Deferred.await(reply)),
                    Effect.ensuring(Deferred.succeed(stopped, undefined)),
                  );
                },
              }),
            ),
          ),
        ),
        scope,
      );
      let destroyed = false;
      const sender = Object.assign(new EventEmitter(), {
        id: 1,
        isDestroyed: () => destroyed,
        send: (_channel: string, event: PageTextRewriteEvent) => {
          Queue.offerUnsafe(emitted, event);
        },
      });
      const event = { sender } as unknown as IpcMainInvokeEvent;
      const other = { sender: { id: 2, isDestroyed: () => false } } as IpcMainInvokeEvent;
      const untrusted = { sender: { id: 9, isDestroyed: () => false } } as IpcMainInvokeEvent;
      const start = handlers.get("page-text-rewrite:start")!;
      const cancel = handlers.get("page-text-rewrite:cancel")!;
      try {
        assert.isTrue(Exit.isFailure(yield* Effect.exit(start(untrusted, { requestId, input }))));
        for (const invalid of [
          { requestId: "bad", input },
          { requestId, input: { ...input, documentId: "document" } },
          { requestId, input: { ...input, markdown: "界".repeat(22_000) } },
          { requestId, input: { ...input, context: { after: "a".repeat(4097) } } },
        ]) {
          assert.deepEqual(yield* start(event, invalid), {
            ok: false,
            error: {
              code: "invalid_input",
              message: "Select less text and enter a rewrite instruction",
            },
          });
        }
        assert.equal(calls.length, 0);
        assert.deepEqual(yield* start(event, { requestId, input }), { ok: true });
        yield* Deferred.await(started);
        assert.deepEqual(yield* start(event, { requestId, input }), {
          ok: false,
          error: { code: "busy", message: "A rewrite is already running. Wait or cancel it" },
        });
        yield* cancel(other, requestId);
        assert.isFalse(yield* Deferred.isDone(stopped));
        yield* cancel(event, "bad");
        assert.isFalse(yield* Deferred.isDone(stopped));
        yield* cancel(event, requestId);
        assert.isTrue(yield* Deferred.isDone(stopped));
        assert.deepEqual(yield* Queue.take(emitted), { requestId, kind: "cancelled" });
        assert.equal(sender.listenerCount("destroyed"), 0);
        started = yield* Deferred.make<void>();
        reply = yield* Deferred.make<string>();
        stopped = yield* Deferred.make<void>();
        yield* start(event, { requestId, input });
        yield* Deferred.await(started);
        yield* Deferred.succeed(reply, "Short");
        assert.deepEqual(yield* Queue.take(emitted), {
          requestId,
          kind: "done",
          markdown: "Short",
        });
        yield* Deferred.await(stopped);
        started = yield* Deferred.make<void>();
        reply = yield* Deferred.make<string>();
        stopped = yield* Deferred.make<void>();
        yield* start(event, { requestId: "ab5ca588-bf54-4fc1-b216-954fa433701e", input });
        yield* Deferred.await(started);
        destroyed = true;
        sender.emit("destroyed");
        yield* Deferred.await(stopped);
        assert.equal(sender.listenerCount("destroyed"), 0);
        destroyed = false;
        started = yield* Deferred.make<void>();
        reply = yield* Deferred.make<string>();
        stopped = yield* Deferred.make<void>();
        yield* start(event, { requestId: "0a5a1bc4-3415-4d35-a16c-e474ac0b8dc8", input });
        yield* Deferred.await(started);
      } finally {
        yield* Scope.close(scope, Exit.succeed(undefined));
      }
      assert.isTrue(yield* Deferred.isDone(stopped));
      assert.equal(sender.listenerCount("destroyed"), 0);
      assert.equal(handlers.size, 0);
    }),
);
