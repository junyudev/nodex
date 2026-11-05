import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type { IpcMainInvokeEvent } from "electron";
import { vi } from "vitest";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { ChatSearch } from "../../chat-search/ChatSearch";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live } from "./ChatSearchIpc";

vi.mock("../../platform/electron/TrustedRendererSender", () => ({
  requireTrustedAppRendererSender: () => undefined,
}));
type Handler = (
  event: IpcMainInvokeEvent,
  ...args: readonly unknown[]
) => Effect.Effect<unknown, unknown>;

it.effect("validates bounded chat queries and rejects callers without an active window", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const handlers = new Map<string, Handler>();
      const calls: unknown[] = [];
      const ipc = makeTestElectronIpc({
        handle: (channel, handler: Handler) =>
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
      yield* Layer.buildWithScope(
        live.pipe(
          Layer.provide(
            Layer.mergeAll(
              mainConfigLayer(),
              Layer.succeed(ElectronIpc, ipc),
              Layer.succeed(WindowRuntime, {
                has: (id: number) => id === 1,
              } as unknown as WindowRuntime["Service"]),
              Layer.succeed(ChatSearch, {
                search: (input) =>
                  Effect.sync(() => {
                    calls.push(input);
                    return { matches: [], complete: true };
                  }),
                searchMessages: (input) =>
                  Effect.sync(() => {
                    calls.push(input);
                    return { matches: [], sources: [] };
                  }),
                rankSessionIds: () => Effect.succeed([]),
              }),
            ),
          ),
        ),
        yield* Scope.Scope,
      );
      const event = {
        sender: { id: 1, isDestroyed: () => false },
      } as unknown as IpcMainInvokeEvent;
      const search = handlers.get("chats:search")!;
      const messages = handlers.get("chats:search-messages")!;
      assert.deepEqual(yield* search(event, { query: " needle ", limit: 10, startedOnly: true }), {
        matches: [],
        complete: true,
      });
      yield* messages(event, { query: " history ", limit: 5 });
      assert.deepEqual(calls, [
        { query: "needle", limit: 10, startedOnly: true },
        { query: "history", limit: 5 },
      ]);
      assert.equal(
        (yield* search(event, { query: "x", limit: 61 }).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(
        (yield* messages(event, { query: " ", limit: 1 }).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(
        (yield* search(
          { sender: { id: 2, isDestroyed: () => false } } as unknown as IpcMainInvokeEvent,
          { query: "", limit: 1 },
        ).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(calls.length, 2);
    }),
  ),
);
