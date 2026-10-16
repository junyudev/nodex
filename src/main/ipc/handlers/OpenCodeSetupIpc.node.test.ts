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
import type { OpenCodeSetupState } from "../../../shared/opencode-setup";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { OpenCodeSetup } from "../../host-runtime/OpenCodeSetup";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live } from "./OpenCodeSetupIpc";

vi.mock("electron", () => ({ BrowserWindow: { fromWebContents: () => ({}) } }));

type Handler = (event: IpcMainInvokeEvent) => Effect.Effect<unknown, unknown>;
const event = (url = "app://-/index.html", subframe = false) => {
  const frame = { url };
  return {
    sender: { getType: () => "window", mainFrame: frame },
    senderFrame: subframe ? { ...frame } : frame,
  } as unknown as IpcMainInvokeEvent;
};

const snapshot: OpenCodeSetupState = {
  revision: 1,
  supported: true,
  command: "official-installer",
  executable: { status: "missing" },
  installation: { phase: "idle" },
};

it.effect("authorizes every setup action before admission and scope-owns the handlers", () =>
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
              OpenCodeSetup,
              OpenCodeSetup.of({
                read: action("read"),
                install: action("install"),
                cancel: action("cancel"),
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
      for (const operation of ["read", "install", "cancel"]) {
        const handler = handlers.get(`opencode-setup:${operation}`);
        assert.isDefined(handler);
        for (const untrusted of [event("https://example.com"), event(undefined, true)]) {
          assert.isTrue(Exit.isFailure(yield* Effect.exit(handler!(untrusted))));
        }
        assert.deepEqual(yield* handler!(event()), snapshot);
      }
      assert.deepEqual(calls, ["read", "install", "cancel"]);
    } finally {
      yield* Scope.close(scope, Exit.void);
    }
    assert.strictEqual(handlers.size, 0);
  }),
);

it.effect("broadcasts setup snapshots to live windows and releases its subscription", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const changes = yield* PubSub.unbounded<OpenCodeSetupState>();
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
              OpenCodeSetup,
              OpenCodeSetup.of({
                read: Effect.succeed(snapshot),
                install: Effect.succeed(snapshot),
                cancel: Effect.succeed(snapshot),
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
      assert.deepEqual(sent, [["opencode-setup:changed", snapshot]]);
    } finally {
      yield* Scope.close(scope, Exit.void);
    }
    assert.isTrue(yield* Deferred.isDone(released));
  }),
);
