import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { assert, it } from "@effect/vitest";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { ApplicationHostRuntime } from "../../host-runtime/ApplicationHostRuntime";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live } from "./ApplicationLifecycleIpc";

it.effect("owns all application lifecycle handlers with the Main Scope", () =>
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
    const windows = {
      acknowledgeClose: () => undefined,
      has: () => true,
    } as unknown as WindowRuntime["Service"];
    const host = ApplicationHostRuntime.of({ requestMicrophonePermission: Effect.void });
    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(
      live.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ApplicationHostRuntime, host),
            Layer.succeed(ElectronIpc, ipc),
            mainConfigLayer(),
            Layer.succeed(WindowRuntime, windows),
          ),
        ),
      ),
      scope,
    );
    assert.strictEqual(channels.size, 1);

    yield* Scope.close(scope, Exit.void);
    assert.strictEqual(channels.size, 0);
  }),
);
