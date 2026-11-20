import { assert, it } from "@effect/vitest";
import type { IpcMainInvokeEvent } from "electron";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { vi } from "vitest";
import type { AppComponentsState } from "../../../shared/app-components";
import { isSpaceIpcChannel } from "../../../shared/space-ipc-policy";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { AppComponents } from "../../app-components/AppComponents";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live } from "./AppComponentsIpc";

vi.mock("electron", () => ({ BrowserWindow: { fromWebContents: () => ({}) } }));

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Effect.Effect<unknown, unknown>;
const event = (url = "app://-/index.html", subframe = false) => {
  const frame = { url };
  return {
    sender: { getType: () => "window", mainFrame: frame },
    senderFrame: subframe ? { ...frame } : frame,
  } as unknown as IpcMainInvokeEvent;
};

const snapshot: AppComponentsState = {
  revision: 1,
  components: [],
};

it.effect("authorizes component requests before admission and scope-owns the handlers", () =>
  Effect.gen(function* () {
    const handlers = new Map<string, Handler>();
    const calls: string[] = [];
    const scope = yield* Scope.make();
    const action = (name: string) =>
      Effect.sync(() => {
        calls.push(name);
        return snapshot;
      });
    const ipc = makeTestElectronIpc({
      handle: (channel: string, handler: Handler) =>
        Effect.acquireRelease(
          Effect.sync(() => handlers.set(channel, handler)),
          () => Effect.sync(() => handlers.delete(channel)),
        ).pipe(Effect.asVoid),
      on: () => Effect.void,
    });
    yield* Layer.buildWithScope(
      live.pipe(
        Layer.provide(
          Layer.mergeAll(
            mainConfigLayer(),
            Layer.succeed(ElectronIpc, ipc),
            Layer.succeed(
              AppComponents,
              AppComponents.of({
                prefetchUpdate: () => Effect.void,
                ensure: () => Effect.die("unexpected ensure"),
                request: () => Effect.die("unexpected request"),
                read: action("read"),
                setEnabled: () => action("set-enabled"),
                retry: () => action("retry"),
                changes: Stream.empty,
              }),
            ),
            Layer.succeed(
              WindowRuntime,
              WindowRuntime.of({ all: () => [] } as unknown as WindowRuntime["Service"]),
            ),
          ),
        ),
      ),
      scope,
    );
    try {
      const operations = [
        ["read", []],
        ["set-enabled", [{ id: "desktop-tools", enabled: false }]],
        ["retry", ["desktop-tools"]],
      ] as const;
      for (const [operation, args] of operations) {
        const channel = `app-components:${operation}` as const;
        assert.isFalse(isSpaceIpcChannel(channel));
        const handler = handlers.get(channel);
        assert.isDefined(handler);
        for (const untrusted of [event("https://example.com"), event(undefined, true)]) {
          assert.isTrue(Exit.isFailure(yield* Effect.exit(handler!(untrusted, ...args))));
        }
        assert.deepEqual(yield* handler!(event(), ...args), snapshot);
      }
      for (const [operation, invalid] of [
        ["set-enabled", { id: "desktop-tools", enabled: "false" }],
        ["retry", "unknown-component"],
      ] as const) {
        const handler = handlers.get(`app-components:${operation}`)!;
        assert.isTrue(Exit.isFailure(yield* Effect.exit(handler(event(), invalid))));
      }
      assert.deepEqual(calls, ["read", "set-enabled", "retry"]);
    } finally {
      yield* Scope.close(scope, Exit.void);
    }
    assert.strictEqual(handlers.size, 0);
  }),
);

it.effect("broadcasts component snapshots to live windows and releases its subscription", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const changes = yield* PubSub.unbounded<AppComponentsState>();
    const delivered = yield* Deferred.make<void>();
    const released = yield* Deferred.make<void>();
    const sent: unknown[][] = [];
    yield* Layer.buildWithScope(
      live.pipe(
        Layer.provide(
          Layer.mergeAll(
            mainConfigLayer(),
            Layer.succeed(
              ElectronIpc,
              makeTestElectronIpc({ handle: () => Effect.void, on: () => Effect.void }),
            ),
            Layer.succeed(
              AppComponents,
              AppComponents.of({
                prefetchUpdate: () => Effect.void,
                ensure: () => Effect.die("unexpected ensure"),
                request: () => Effect.die("unexpected request"),
                read: Effect.succeed(snapshot),
                setEnabled: () => Effect.succeed(snapshot),
                retry: () => Effect.succeed(snapshot),
                changes: Stream.fromPubSub(changes).pipe(
                  Stream.tap(() => Deferred.succeed(delivered, undefined)),
                  Stream.ensuring(Deferred.succeed(released, undefined)),
                ),
              }),
            ),
            Layer.succeed(
              WindowRuntime,
              WindowRuntime.of({
                all: () => [
                  {
                    isDestroyed: () => false,
                    webContents: {
                      isDestroyed: () => false,
                      send: (...args: unknown[]) => sent.push(args),
                    },
                  },
                  { isDestroyed: () => true },
                ],
              } as unknown as WindowRuntime["Service"]),
            ),
          ),
        ),
      ),
      scope,
    );
    try {
      yield* PubSub.publish(changes, snapshot);
      yield* Deferred.await(delivered);
      yield* Effect.yieldNow;
      assert.deepEqual(sent, [["app-components:changed", snapshot]]);
    } finally {
      yield* Scope.close(scope, Exit.void);
    }
    assert.isTrue(yield* Deferred.isDone(released));
  }),
);
