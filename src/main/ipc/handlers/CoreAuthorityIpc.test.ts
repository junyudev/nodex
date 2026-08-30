import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { assert, it } from "@effect/vitest";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { CoreAuthority, type CoreAuthorityState } from "../../core-runtime/CoreAuthority";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live, toRendererStatus } from "./CoreAuthorityIpc";

it("projects Effect Core states to the stable renderer contract", () => {
  assert.deepEqual(
    toRendererStatus({
      kind: "recovering",
      attempt: 2,
      previousGeneration: "generation-1",
    }),
    { kind: "recovering", attempt: 2 },
  );
  assert.deepEqual(toRendererStatus({ kind: "stopped" }), {
    kind: "unavailable",
    circuitOpen: false,
    message: "Nodex Core has stopped.",
  });
});

it.effect("owns all Core authority IPC handlers with the Main Scope", () =>
  Effect.gen(function* () {
    const state = yield* SubscriptionRef.make<CoreAuthorityState>({
      kind: "ready",
      generation: "generation-1",
    });
    const channels = new Set<string>();
    const ipc = makeTestElectronIpc({
      handle: (channel, _handler) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            channels.add(channel);
          }),
          () => Effect.sync(() => channels.delete(channel)),
        ),
      on: <Args extends readonly unknown[]>(
        _channel: string,
        _handler: (event: never, ...args: Args) => Effect.Effect<void>,
      ) => Effect.void,
    });
    const authority = CoreAuthority.of({
      identity: { profileId: "profile", libraryId: "library", storeEpoch: "epoch" },
      initialLaunch: {} as CoreAuthority["Service"]["initialLaunch"],
      state,
      retry: Effect.void,
      requestRelaunch: Effect.void,
      failApplication: () => Effect.succeed(true),
    });
    const windows = {
      all: () => [],
      has: () => true,
    } as unknown as WindowRuntime["Service"];
    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(
      live.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(CoreAuthority, authority),
            Layer.succeed(ElectronIpc, ipc),
            mainConfigLayer(),
            Layer.succeed(WindowRuntime, windows),
          ),
        ),
      ),
      scope,
    );
    assert.strictEqual(channels.size, 3);

    yield* Scope.close(scope, Exit.void);
    assert.strictEqual(channels.size, 0);
  }),
);
