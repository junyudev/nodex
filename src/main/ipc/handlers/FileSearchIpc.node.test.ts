import { EventEmitter } from "node:events";
import type { IpcMainInvokeEvent } from "electron";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { CodexGateway } from "../../codex-runtime/CodexGateway";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import type { FileSearchIpcError } from "./FileSearchIpc";
import type { CodexRuntimeError } from "../../codex-runtime/CodexRuntimeError";
import { live } from "./FileSearchIpc";

vi.mock("../../platform/electron/TrustedRendererSender", () => ({
  requireTrustedAppRendererSender: () => undefined,
}));

type Handler = (
  event: IpcMainInvokeEvent,
  input: unknown,
) => Effect.Effect<unknown, FileSearchIpcError | CodexRuntimeError>;

it.effect(
  "restricts updates to the owning window and stops on window destruction or Main shutdown",
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
      const stopped = yield* Deferred.make<void>();
      const calls: Array<{ method: string; sessionId: string }> = [];
      const gateway = {
        localHostId: "local",
        events: Stream.never,
        awaitReady: () => Effect.void,
        connection: () => Effect.succeed({ kind: "ready", hostId: "local", generation: 1 }),
        requestOnHost: (_host: string, method: string, params: { sessionId: string }) =>
          Effect.gen(function* () {
            calls.push({ method, sessionId: params.sessionId });
            if (method === "fuzzyFileSearch/sessionStop")
              yield* Deferred.succeed(stopped, undefined);
            return {};
          }),
      } as unknown as CodexGateway["Service"];
      const scope = yield* Scope.make();
      yield* Layer.buildWithScope(
        live.pipe(
          Layer.provide(
            Layer.mergeAll(
              mainConfigLayer(),
              Layer.succeed(ElectronIpc, ipc),
              Layer.succeed(CodexGateway, gateway),
              Layer.succeed(WindowRuntime, {
                has: () => true,
              } as unknown as WindowRuntime["Service"]),
            ),
          ),
        ),
        scope,
      );
      const sender = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false });
      const other = Object.assign(new EventEmitter(), { id: 2, isDestroyed: () => false });
      const event = { sender } as unknown as IpcMainInvokeEvent;
      const otherEvent = { sender: other } as unknown as IpcMainInvokeEvent;
      const input = {
        hostId: "local",
        sessionId: "128cc777-30ab-4c91-8857-a2083e8349f1",
        roots: ["/repo"],
      };
      const start = handlers.get("file-search:start")!;
      const update = handlers.get("file-search:update")!;
      yield* start(event, input);
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(update(otherEvent, { sessionId: input.sessionId, query: "abc" })),
        ),
      );
      yield* start(otherEvent, input);
      assert.notStrictEqual(calls[0]?.sessionId, calls[1]?.sessionId);
      assert.notStrictEqual(calls[0]?.sessionId, input.sessionId);
      yield* update(event, { sessionId: input.sessionId, query: "abc" });
      sender.emit("destroyed");
      yield* Deferred.await(stopped);
      assert.strictEqual(sender.listenerCount("destroyed"), 0);
      yield* update(otherEvent, { sessionId: input.sessionId, query: "other" });
      yield* Scope.close(scope, Exit.succeed(undefined));
      assert.strictEqual(other.listenerCount("destroyed"), 0);
      assert.strictEqual(handlers.size, 0);
      assert.deepEqual(
        calls.map((call) => call.method),
        [
          "fuzzyFileSearch/sessionStart",
          "fuzzyFileSearch/sessionStart",
          "fuzzyFileSearch/sessionUpdate",
          "fuzzyFileSearch/sessionStop",
          "fuzzyFileSearch/sessionUpdate",
          "fuzzyFileSearch/sessionStop",
        ],
      );
      assert.strictEqual(calls[2]?.sessionId, calls[0]?.sessionId);
      assert.strictEqual(calls[3]?.sessionId, calls[0]?.sessionId);
      assert.strictEqual(calls[4]?.sessionId, calls[1]?.sessionId);
      assert.strictEqual(calls[5]?.sessionId, calls[1]?.sessionId);
    }),
);
