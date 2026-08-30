import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { assert, it } from "@effect/vitest";
import type { IpcMainInvokeEvent } from "electron";
import type { PageSearchCommandResult } from "../../../shared/types";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { LibraryModule } from "../../library-application/LibraryModule";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live } from "./PageSearchIpc";

type Handler = (event: IpcMainInvokeEvent, ...args: readonly unknown[]) => Effect.Effect<unknown>;

it.effect("cancels an owned search and releases every handler with the Main Scope", () =>
  Effect.gen(function* () {
    const handlers = new Map<string, Handler>();
    const ipc = makeTestElectronIpc({
      handle: (channel: string, handler: Handler) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            handlers.set(channel, handler);
          }),
          () => Effect.sync(() => handlers.delete(channel)),
        ),
      on: () => Effect.die("unused"),
    });
    let observeStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      observeStarted = resolve;
    });
    const library = {
      searchPages: () =>
        Effect.callback<never>(() => {
          observeStarted?.();
          return Effect.void;
        }),
    } as unknown as LibraryModule["Service"];
    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(
      live({ authorizeSender: () => true }).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ElectronIpc, ipc),
            Layer.succeed(LibraryModule, library),
            mainConfigLayer(),
            Layer.succeed(WindowRuntime, {
              has: () => true,
            } as unknown as WindowRuntime["Service"]),
          ),
        ),
      ),
      scope,
    );
    assert.strictEqual(handlers.size, 4);

    const event = { sender: { id: 41 } } as IpcMainInvokeEvent;
    const search = handlers.get("pages:search");
    const cancel = handlers.get("pages:search:cancel");
    assert.isDefined(search);
    assert.isDefined(cancel);
    const fiber = yield* Effect.forkChild(
      search(event, "query-1", {
        projectIds: ["project-1"],
        query: "test",
      }) as Effect.Effect<PageSearchCommandResult>,
    );
    yield* Effect.promise(() => started);
    const cancelled = yield* cancel(event, "query-1");
    assert.isTrue(cancelled);
    assert.deepStrictEqual(yield* Fiber.join(fiber), { status: "cancelled" });

    yield* Scope.close(scope, Exit.void);
    assert.strictEqual(handlers.size, 0);
  }),
);
