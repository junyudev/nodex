import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { assert, it } from "@effect/vitest";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { layer as mainShutdownLayer } from "../../app/MainShutdown";
import { ApplicationInitializationRuntime } from "../../host-runtime/ApplicationInitializationRuntime";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { ApplicationWindowShellRuntime } from "../../window-runtime/ApplicationWindowShellRuntime";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live } from "./ApplicationBootstrapIpc";

it.effect("owns only the trusted bootstrap handlers before Core is ready", () =>
  Effect.gen(function* () {
    const channels = new Set<string>();
    const register = (channel: string) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          channels.add(channel);
        }),
        () => Effect.sync(() => channels.delete(channel)),
      );
    const ipc = makeTestElectronIpc({
      handle: (channel: string) => register(channel),
      on: (channel: string) => register(channel),
    });
    const initialization = ApplicationInitializationRuntime.of({
      awaitDone: Effect.void,
      current: Effect.succeed({ phase: "done" }),
      reportRenderer: () => Effect.void,
    } as unknown as ApplicationInitializationRuntime["Service"]);
    const shell = ApplicationWindowShellRuntime.of({
      awaitActivation: () => Effect.void,
      reportRenderer: () => undefined,
    } as unknown as ApplicationWindowShellRuntime["Service"]);
    const windows = WindowRuntime.of({
      acknowledgeClose: () => undefined,
      has: () => true,
    } as unknown as WindowRuntime["Service"]);
    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(
      live.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ApplicationInitializationRuntime, initialization),
            Layer.succeed(ApplicationWindowShellRuntime, shell),
            Layer.succeed(ElectronIpc, ipc),
            mainShutdownLayer,
            mainConfigLayer(),
            Layer.succeed(WindowRuntime, windows),
          ),
        ),
      ),
      scope,
    );
    assert.deepStrictEqual([...channels].sort(), [
      "app:await-initialization",
      "app:flush-before-close:done",
      "app:renderer-initialization-finished",
      "app:restart",
    ]);

    yield* Scope.close(scope, Exit.void);
    assert.strictEqual(channels.size, 0);
  }),
);
