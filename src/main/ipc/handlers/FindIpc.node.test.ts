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
import { live } from "./FindIpc";
import { CoreModules } from "../../core-runtime/CoreModules";
import { LibraryModule } from "../../library-application/LibraryModule";

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
              Layer.succeed(CoreModules, {} as CoreModules["Service"]),
              Layer.succeed(LibraryModule, {} as LibraryModule["Service"]),
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
                    return { matches: [], truncated: false, sources: [] };
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
      const search = handlers.get("find:search")!;
      const input = {
        query: " needle ",
        kinds: ["chat"],
        place: { kind: "everywhere" },
        limit: 10,
      };
      const response = yield* search(event, input, "instant");
      assert.include(response as object, { phase: "instant", nextCursor: null });
      assert.equal((calls[0] as { query: string }).query, "needle");
      assert.equal(
        (yield* search(event, { ...input, limit: 161 }, "instant").pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal((yield* search(event, input, "bad_phase").pipe(Effect.result))._tag, "Failure");
      assert.equal(
        (yield* search(
          { sender: { id: 2, isDestroyed: () => false } } as unknown as IpcMainInvokeEvent,
          input,
          "instant",
        ).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(calls.length, 1);
    }),
  ),
);
